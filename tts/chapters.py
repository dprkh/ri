from __future__ import annotations

import argparse
import bisect
import html
import json
import math
import multiprocessing
import os
import re
import shutil
import subprocess
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(ROOT / ".hf-cache"))
os.environ.setdefault("HF_HUB_CACHE", str(ROOT / ".hf-cache" / "hub"))

# Kokoro and Torch read the cache environment at import time.
import soundfile as sf
import torch
from kokoro import KPipeline

SAMPLE_RATE = 24000
SCHEMA = "ri.reader-audio-manifest.v1"
ELLIPSIS_PAUSE_SECONDS = 1.0
KOKORO_REPO_ID = "hexgrad/Kokoro-82M"
PRONUNCIATIONS = (
    ("Gu Yue", "ɡˈu jˈu"),
    ("Fang Yuan", "fˈɑŋ jˈwɛn"),
    ("Cicada", "sɪkˈɑːdə"),
)
PRONUNCIATION_OVERRIDES = tuple(
    (
        re.compile(rf"(?<!\[)\b{re.escape(text)}\b(?!\]\()"),
        f"[{text}](/{phonemes}/)",
    )
    for text, phonemes in PRONUNCIATIONS
)
ALIGNMENT_QUOTE_CHARACTERS = frozenset("'\"‘’‚‛“”„‟«»")
ALIGNMENT_DASH_CHARACTERS = frozenset("‐‑‒–—―−")
WORKER_ARGS: argparse.Namespace | None = None
WORKER_PIPELINE: KPipeline | None = None


@dataclass(frozen=True)
class ChapterOutputPaths:
    out: Path
    wav: Path
    m4a: Path
    webm: Path
    manifest: Path


@dataclass(frozen=True)
class ChapterPaths(ChapterOutputPaths):
    chapter: Path


@dataclass
class Block:
    id: str
    kind: str
    text: str
    source_start: int | None = None
    source_end: int | None = None
    start: float | None = None
    end: float | None = None
    token_start: int | None = None
    token_end: int | None = None
    chunks: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AudioChunk:
    id: str
    block_id: str
    block_index: int
    text: str
    start: float
    end: float
    char_start: int
    char_end: int

    def as_manifest(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "blockId": self.block_id,
            "blockIndex": self.block_index,
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "charStart": self.char_start,
            "charEnd": self.char_end,
        }


@dataclass(frozen=True)
class TimedCue:
    id: str
    block_id: str
    block_index: int
    chunk_id: str
    text: str
    start: float
    end: float
    char_start: int
    char_end: int
    is_word: bool

    def as_manifest(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "blockId": self.block_id,
            "blockIndex": self.block_index,
            "chunkId": self.chunk_id,
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "charStart": self.char_start,
            "charEnd": self.char_end,
            "isWord": self.is_word,
        }


@dataclass(frozen=True)
class SeekIndexEntry:
    time: float
    cue_index: int
    block_id: str
    block_index: int
    char_start: int

    def as_manifest(self) -> dict[str, Any]:
        return {
            "time": self.time,
            "cueIndex": self.cue_index,
            "blockId": self.block_id,
            "blockIndex": self.block_index,
            "charStart": self.char_start,
        }


@dataclass(frozen=True)
class ChapterStats:
    chapter: str
    duration: float
    blocks: int
    cues: int
    elapsed: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate reader-app audio and highlighting JSON for one chapter "
            "or chapter range."
        ),
    )
    parser.add_argument(
        "chapters",
        nargs="*",
        default=["1"],
        help="Chapter ids or inclusive ranges, for example: 1 5-14.",
    )
    parser.add_argument(
        "--chapters-dir",
        default="../scripts/output/md",
        help="Directory containing chapter Markdown files.",
    )
    parser.add_argument(
        "--out-dir",
        default="out/chapters",
        help="Directory where chapter assets are written.",
    )
    parser.add_argument("--voice", default="af_heart", help="Kokoro voice id.")
    parser.add_argument("--lang", default="a", help="Kokoro language code.")
    parser.add_argument("--device", default="cpu", help="Kokoro device: cpu, cuda, or mps.")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed.")
    parser.add_argument("--aac-bitrate", default="64k", help="AAC fallback bitrate.")
    parser.add_argument("--opus-bitrate", default="40k", help="Opus primary bitrate.")
    parser.add_argument(
        "--seek-step",
        type=float,
        default=5.0,
        help="Seconds between coarse seek-index entries.",
    )
    parser.add_argument(
        "--keep-wav",
        action="store_true",
        help="Keep the intermediate WAV next to encoded browser audio.",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=1,
        help="Number of chapter worker processes. Each worker loads one Kokoro pipeline.",
    )
    parser.add_argument(
        "--torch-threads",
        type=int,
        default=None,
        help=(
            "Torch intra-op threads per process. Defaults to all Torch threads "
            "for one job or CPU count divided by jobs."
        ),
    )
    parser.add_argument(
        "--torch-interop-threads",
        type=int,
        default=None,
        help=(
            "Torch inter-op threads per process. Defaults to Torch's setting "
            "for one job or 1 for multiple jobs."
        ),
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip chapters that already have alignment JSON, WebM, and M4A outputs.",
    )
    return parser.parse_args()


def absolute_from_root(path: str) -> Path:
    candidate = Path(path)
    return candidate if candidate.is_absolute() else (ROOT / candidate).resolve()


def parse_chapter_selection(values: list[str]) -> list[str]:
    chapter_ids: list[str] = []
    seen: set[str] = set()
    for value in values:
        if re.fullmatch(r"[1-9]\d*", value):
            candidates = [int(value)]
        else:
            range_match = re.fullmatch(r"([1-9]\d*)-([1-9]\d*)", value)
            if not range_match:
                raise RuntimeError(
                    f"Invalid chapter selector {value!r}; use ids like 7 or ranges like 5-14",
                )
            start = int(range_match.group(1))
            end = int(range_match.group(2))
            if end < start:
                raise RuntimeError(
                    f"Invalid chapter range {value!r}; range end must be "
                    "greater than or equal to start",
                )
            candidates = list(range(start, end + 1))
        for candidate in candidates:
            chapter_id = str(candidate)
            if chapter_id not in seen:
                seen.add(chapter_id)
                chapter_ids.append(chapter_id)
    if not chapter_ids:
        raise RuntimeError("No chapters selected")
    return chapter_ids


def chapter_paths(args: argparse.Namespace, chapter_id: str) -> ChapterPaths:
    out_dir = absolute_from_root(args.out_dir) / chapter_id
    return ChapterPaths(
        out=out_dir,
        wav=out_dir / f"chapter-{chapter_id}.wav",
        m4a=out_dir / f"chapter-{chapter_id}.m4a",
        webm=out_dir / f"chapter-{chapter_id}.webm",
        manifest=out_dir / f"chapter-{chapter_id}.alignment.json",
        chapter=absolute_from_root(args.chapters_dir) / f"{chapter_id}.md",
    )


def generated_assets_exist(args: argparse.Namespace, chapter_id: str) -> bool:
    paths = chapter_paths(args, chapter_id)
    generated_paths = (paths.manifest, paths.webm, paths.m4a)
    if not all(path.is_file() and path.stat().st_size > 0 for path in generated_paths):
        return False
    with paths.manifest.open(encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
    if manifest.get("schema") != SCHEMA or manifest.get("chapter") != chapter_id:
        raise RuntimeError(
            f"Existing manifest for chapter {chapter_id} is invalid: {paths.manifest}",
        )
    return True


def validate_runtime_args(args: argparse.Namespace) -> None:
    if args.jobs < 1:
        raise RuntimeError("--jobs must be at least 1")
    if args.torch_threads is not None and args.torch_threads < 1:
        raise RuntimeError("--torch-threads must be at least 1")
    if args.torch_interop_threads is not None and args.torch_interop_threads < 1:
        raise RuntimeError("--torch-interop-threads must be at least 1")
    if args.seek_step <= 0:
        raise RuntimeError("--seek-step must be greater than 0")


def configured_torch_threads(args: argparse.Namespace) -> tuple[int, int]:
    if args.torch_threads is not None:
        intra_threads = args.torch_threads
    elif args.jobs == 1:
        intra_threads = torch.get_num_threads()
    else:
        intra_threads = max(1, math.floor((os.cpu_count() or 1) / args.jobs))

    if args.torch_interop_threads is not None:
        interop_threads = args.torch_interop_threads
    elif args.jobs == 1:
        interop_threads = torch.get_num_interop_threads()
    else:
        interop_threads = 1

    return intra_threads, interop_threads


def configure_torch_runtime(args: argparse.Namespace) -> tuple[int, int]:
    intra_threads, interop_threads = configured_torch_threads(args)
    torch.set_num_threads(intra_threads)
    torch.set_num_interop_threads(interop_threads)
    return intra_threads, interop_threads


def format_elapsed(value: float) -> str:
    seconds_value = int(round(value))
    minutes, seconds_remainder = divmod(seconds_value, 60)
    hours, minutes_remainder = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes_remainder}m {seconds_remainder}s"
    if minutes:
        return f"{minutes}m {seconds_remainder}s"
    return f"{seconds_remainder}s"


def model_load_summary(total_audio: float, batch_elapsed: float, load_elapsed: float) -> str:
    if not load_elapsed:
        return ""
    total_elapsed = batch_elapsed + load_elapsed
    return f", {total_audio / total_elapsed:.2f}x including model load"


def parse_frontmatter(raw: str) -> tuple[dict[str, str], str, int]:
    match = re.match(r"\A---\n(.*?)\n---\n?", raw, flags=re.DOTALL)
    if not match:
        return {}, raw, 0
    values: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, separator, value = line.partition(":")
        if separator:
            values[key.strip()] = value.strip().strip('"')
    return values, raw[match.end() :], match.end()


def remove_footnote_definitions(markdown: str) -> str:
    kept: list[str] = []
    skipping = False
    for line in markdown.splitlines():
        if re.match(r"^\[\^[^\]]+\]:", line):
            skipping = True
            continue
        if skipping and (line.startswith(" ") or line.startswith("\t")):
            continue
        skipping = False
        kept.append(line)
    return "\n".join(kept)


def clean_inline_markdown(text: str) -> str:
    cleaned = html.unescape(text)
    cleaned = re.sub(r"\[\^[^\]]+\]", "", cleaned)
    cleaned = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"`([^`]*)`", r"\1", cleaned)
    cleaned = re.sub(r"(\*\*|__)(.*?)\1", r"\2", cleaned)
    cleaned = re.sub(r"(\*|_)(.*?)\1", r"\2", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def apply_pronunciation_overrides(text: str) -> str:
    prepared = text
    for pattern, replacement in PRONUNCIATION_OVERRIDES:
        prepared = pattern.sub(replacement, prepared)
    return prepared


def is_silent_pause_block(text: str) -> bool:
    return not any(character.isalnum() for character in text)


def parse_chapter(path: Path) -> tuple[str, list[Block]]:
    raw = path.read_text(encoding="utf-8")
    frontmatter, body, body_offset = parse_frontmatter(raw)
    body = remove_footnote_definitions(body)
    title = frontmatter.get("title", path.stem)
    blocks: list[Block] = []
    block_pattern = re.compile(r"\S(?:.*?)(?=\n\s*\n|\Z)", flags=re.DOTALL)
    for block_index, match in enumerate(block_pattern.finditer(body), start=1):
        raw_block = match.group(0).strip()
        heading = re.match(r"^(#{1,6})\s+(.+)$", raw_block)
        kind = "heading" if heading else "paragraph"
        text = clean_inline_markdown(heading.group(2) if heading else raw_block)
        if not text:
            continue
        blocks.append(
            Block(
                id=f"p{block_index:04d}",
                kind=kind,
                text=text,
                source_start=body_offset + match.start(),
                source_end=body_offset + match.end(),
            ),
        )
    if not blocks:
        raise RuntimeError(f"{path} did not contain any readable chapter text")
    return title, blocks


def audio_array(audio: Any) -> Any:
    return audio.detach().cpu().numpy() if hasattr(audio, "detach") else audio


def seconds(frames: int) -> float:
    return round(frames / SAMPLE_RATE, 3)


def normalize_alignment_text(text: str, source_offset: int = 0) -> tuple[str, list[int]]:
    normalized: list[str] = []
    source_indexes: list[int] = []
    previous_was_space = False

    def append(character: str, source_index: int) -> None:
        nonlocal previous_was_space
        if character.isspace():
            if previous_was_space:
                return
            character = " "
            previous_was_space = True
        else:
            previous_was_space = False
        normalized.append(character.casefold())
        source_indexes.append(source_index)

    for index, character in enumerate(text):
        source_index = source_offset + index
        if character in ALIGNMENT_QUOTE_CHARACTERS:
            continue
        if character == "…":
            for replacement in "...":
                append(replacement, source_index)
            continue
        if character in ALIGNMENT_DASH_CHARACTERS:
            append("-", source_index)
            continue
        for replacement in unicodedata.normalize("NFKC", character):
            append(replacement, source_index)
    return "".join(normalized), source_indexes


def locate_ignored_alignment_span(
    source_text: str,
    target_text: str,
    cursor: int,
    limit: int,
) -> tuple[int, int] | None:
    if not target_text:
        raise RuntimeError("Unable to locate empty text span")
    for index in range(cursor, limit - len(target_text) + 1):
        source_slice = source_text[index : index + len(target_text)]
        if len(source_slice) == len(target_text) and all(
            source_character in ALIGNMENT_QUOTE_CHARACTERS
            and target_character in ALIGNMENT_QUOTE_CHARACTERS
            for source_character, target_character in zip(source_slice, target_text)
        ):
            return index, index + len(target_text)
    return None


def expand_alignment_span(
    source_text: str,
    start: int,
    end: int,
    cursor: int,
    limit: int,
) -> tuple[int, int]:
    while start > cursor and source_text[start - 1] in ALIGNMENT_QUOTE_CHARACTERS:
        start -= 1
    while end < limit and source_text[end] in ALIGNMENT_QUOTE_CHARACTERS:
        end += 1
    return start, end


def locate_text_span(
    source_text: str,
    target_text: str,
    cursor: int,
    failure_label: str,
    limit: int | None = None,
) -> tuple[int, int]:
    search_limit = len(source_text) if limit is None else limit
    exact_index = source_text.find(target_text, cursor, search_limit)
    if exact_index >= 0:
        return exact_index, exact_index + len(target_text)

    normalized_target, _ = normalize_alignment_text(target_text)
    if not normalized_target:
        ignored_span = locate_ignored_alignment_span(source_text, target_text, cursor, search_limit)
        if ignored_span is not None:
            return ignored_span
        raise RuntimeError(f"Unable to locate {failure_label}: {target_text[:80]!r}")

    normalized_source, source_indexes = normalize_alignment_text(
        source_text[cursor:search_limit],
        source_offset=cursor,
    )
    normalized_index = normalized_source.find(normalized_target)
    if normalized_index < 0:
        raise RuntimeError(f"Unable to locate {failure_label}: {target_text[:80]!r}")

    matched_indexes = source_indexes[normalized_index : normalized_index + len(normalized_target)]
    start = matched_indexes[0]
    end = matched_indexes[-1] + 1
    return expand_alignment_span(source_text, start, end, cursor, search_limit)


def locate_chunk(block_text: str, chunk_text: str, cursor: int) -> tuple[int, int]:
    return locate_text_span(block_text, chunk_text, cursor, "synthesized chunk")


def locate_token(block_text: str, token_text: str, cursor: int, limit: int) -> tuple[int, int]:
    return locate_text_span(block_text, token_text, cursor, f"token {token_text!r}", limit)


def run_ffmpeg(args: list[str]) -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is required to encode .m4a and .webm outputs")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def encode_audio(
    wav_path: Path,
    m4a_path: Path,
    webm_path: Path,
    aac_bitrate: str,
    opus_bitrate: str,
) -> None:
    run_ffmpeg(
        [
            "-i",
            str(wav_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "aac",
            "-b:a",
            aac_bitrate,
            "-movflags",
            "+faststart",
            str(m4a_path),
        ],
    )
    run_ffmpeg(
        [
            "-i",
            str(wav_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-c:a",
            "libopus",
            "-b:a",
            opus_bitrate,
            "-vbr",
            "on",
            "-compression_level",
            "10",
            str(webm_path),
        ],
    )


def temporary_chapter_paths(out_dir: Path, chapter_id: str) -> ChapterOutputPaths:
    temp_dir = out_dir / f".chapter-{chapter_id}.tmp-{os.getpid()}-{time.time_ns()}"
    return ChapterOutputPaths(
        out=temp_dir,
        wav=temp_dir / f"chapter-{chapter_id}.wav",
        m4a=temp_dir / f"chapter-{chapter_id}.m4a",
        webm=temp_dir / f"chapter-{chapter_id}.webm",
        manifest=temp_dir / f"chapter-{chapter_id}.alignment.json",
    )


def chunks_by_id(chunks: list[AudioChunk]) -> dict[str, AudioChunk]:
    return {chunk.id: chunk for chunk in chunks}


def validate_blocks(blocks: list[Block]) -> None:
    for block in blocks:
        has_timing = (
            block.start is not None
            and block.end is not None
            and block.token_start is not None
            and block.token_end is not None
        )
        if not has_timing:
            raise RuntimeError(f"Block {block.id} is missing manifest timing metadata")
        if block.end < block.start:
            raise RuntimeError(f"Block {block.id} ends before it starts")
        if block.token_end < block.token_start:
            raise RuntimeError(f"Block {block.id} token bounds are invalid")
        if not block.chunks:
            raise RuntimeError(f"Block {block.id} has no chunk references")


def validate_chunks(blocks: list[Block], chunks: list[AudioChunk], block_ids: set[str]) -> None:
    previous_start = -1.0
    for chunk in chunks:
        if chunk.block_id not in block_ids:
            raise RuntimeError(f"Chunk {chunk.id} references missing block {chunk.block_id}")
        if chunk.end < chunk.start or chunk.start < previous_start:
            raise RuntimeError(f"Chunk {chunk.id} timings are invalid or unsorted")
        if chunk.block_index < 0 or chunk.block_index >= len(blocks):
            raise RuntimeError(
                f"Chunk {chunk.id} references block index {chunk.block_index} "
                "outside the block list",
            )

        block = blocks[chunk.block_index]
        invalid_bounds = (
            chunk.block_id != block.id
            or chunk.char_start < 0
            or chunk.char_end < chunk.char_start
            or chunk.char_end > len(block.text)
        )
        if invalid_bounds:
            raise RuntimeError(f"Chunk {chunk.id} has invalid block or character bounds")
        previous_start = chunk.start


def validate_cues(
    cues: list[TimedCue],
    chunks: list[AudioChunk],
    block_ids: set[str],
    chunk_ids: set[str],
) -> None:
    previous_start = -1.0
    chunk_lookup = chunks_by_id(chunks)
    for cue in cues:
        if cue.block_id not in block_ids:
            raise RuntimeError(f"Cue {cue.id} references missing block {cue.block_id}")
        if cue.chunk_id not in chunk_ids:
            raise RuntimeError(f"Cue {cue.id} references missing chunk {cue.chunk_id}")
        if cue.end < cue.start or cue.start < previous_start:
            raise RuntimeError(f"Cue {cue.id} timings are invalid or unsorted")

        chunk = chunk_lookup[cue.chunk_id]
        chunk_char_count = chunk.char_end - chunk.char_start
        invalid_bounds = (
            cue.block_id != chunk.block_id
            or cue.char_start < 0
            or cue.char_end < cue.char_start
            or cue.char_end > chunk_char_count
            or cue.start < chunk.start - 0.001
            or cue.end > chunk.end + 0.001
        )
        if invalid_bounds:
            raise RuntimeError(f"Cue {cue.id} has invalid chunk or character bounds")
        previous_start = cue.start


def validate_seek_index_entries(
    seek_index: list[SeekIndexEntry],
    cues: list[TimedCue],
    block_ids: set[str],
) -> None:
    for seek in seek_index:
        if seek.block_id not in block_ids:
            raise RuntimeError(
                f"Seek entry at {seek.time} references missing block {seek.block_id}",
            )
        if seek.cue_index < 0 or seek.cue_index >= len(cues):
            raise RuntimeError(
                f"Seek entry at {seek.time} references cue {seek.cue_index} outside the cue list",
            )

        cue = cues[seek.cue_index]
        if seek.block_id != cue.block_id or seek.block_index != cue.block_index:
            raise RuntimeError(f"Seek entry at {seek.time} does not match cue {cue.id}")


def validate_manifest_parts(
    chapter_id: str,
    blocks: list[Block],
    chunks: list[AudioChunk],
    cues: list[TimedCue],
    seek_index: list[SeekIndexEntry],
    duration: float,
) -> None:
    if duration <= 0:
        raise RuntimeError(f"Chapter {chapter_id} duration must be positive")
    if not chunks:
        raise RuntimeError(f"Chapter {chapter_id} did not produce any audio chunks")
    if not cues:
        raise RuntimeError(f"Chapter {chapter_id} did not produce any timed cues")

    block_ids = {block.id for block in blocks}
    chunk_ids = {chunk.id for chunk in chunks}
    validate_blocks(blocks)
    validate_chunks(blocks, chunks, block_ids)
    validate_cues(cues, chunks, block_ids, chunk_ids)
    validate_seek_index_entries(seek_index, cues, block_ids)


def append_audio_chunk(
    block: Block,
    block_index: int,
    chunks: list[AudioChunk],
    text: str,
    start: float,
    end: float,
    char_start: int,
    char_end: int,
) -> AudioChunk:
    chunk = AudioChunk(
        id=f"c{len(chunks):05d}",
        block_id=block.id,
        block_index=block_index,
        text=text,
        start=start,
        end=end,
        char_start=char_start,
        char_end=char_end,
    )
    block.chunks.append(chunk.id)
    chunks.append(chunk)
    return chunk


def append_token_cues(
    block: Block,
    block_index: int,
    chunk: AudioChunk,
    tokens: Any,
    cues: list[TimedCue],
) -> None:
    token_cursor = chunk.char_start
    for token in tokens or []:
        token_text = token.text
        if not token_text:
            continue

        token_start_char, token_end_char = locate_token(
            block.text,
            token_text,
            token_cursor,
            chunk.char_end,
        )
        token_cursor = token_end_char
        if token.start_ts is None or token.end_ts is None:
            continue

        cues.append(
            TimedCue(
                id=f"t{len(cues):06d}",
                block_id=block.id,
                block_index=block_index,
                chunk_id=chunk.id,
                text=token_text,
                start=round(chunk.start + token.start_ts, 3),
                end=round(chunk.start + token.end_ts, 3),
                char_start=token_start_char - chunk.char_start,
                char_end=token_end_char - chunk.char_start,
                is_word=any(character.isalnum() for character in token_text),
            ),
        )


def write_silent_pause_block(
    wav: sf.SoundFile,
    block: Block,
    block_index: int,
    chunks: list[AudioChunk],
    cues: list[TimedCue],
    total_frames: int,
) -> int:
    pause_frames = int(round(SAMPLE_RATE * ELLIPSIS_PAUSE_SECONDS))
    pause_start = seconds(total_frames)
    wav.write([0.0] * pause_frames)
    total_frames += pause_frames
    pause_end = seconds(total_frames)

    chunk = append_audio_chunk(
        block=block,
        block_index=block_index,
        chunks=chunks,
        text=block.text,
        start=pause_start,
        end=pause_end,
        char_start=0,
        char_end=len(block.text),
    )
    cues.append(
        TimedCue(
            id=f"t{len(cues):06d}",
            block_id=block.id,
            block_index=block_index,
            chunk_id=chunk.id,
            text=block.text,
            start=pause_start,
            end=pause_end,
            char_start=0,
            char_end=len(block.text),
            is_word=False,
        ),
    )
    return total_frames


def write_spoken_block(
    wav: sf.SoundFile,
    block: Block,
    block_index: int,
    pipeline: KPipeline,
    args: argparse.Namespace,
    chunks: list[AudioChunk],
    cues: list[TimedCue],
    total_frames: int,
) -> int:
    chunk_cursor = 0
    prepared_text = apply_pronunciation_overrides(block.text)

    for result in pipeline(prepared_text, voice=args.voice, speed=args.speed):
        if result.audio is None:
            raise RuntimeError(f"Kokoro did not return audio for block {block.id}")

        chunk_text = result.graphemes.strip()
        if not chunk_text:
            continue

        chunk_start_char, chunk_end_char = locate_chunk(block.text, chunk_text, chunk_cursor)
        chunk_cursor = chunk_end_char
        chunk_audio = audio_array(result.audio)
        chunk_start = seconds(total_frames)
        wav.write(chunk_audio)
        total_frames += len(chunk_audio)
        chunk_end = seconds(total_frames)

        chunk = append_audio_chunk(
            block=block,
            block_index=block_index,
            chunks=chunks,
            text=chunk_text,
            start=chunk_start,
            end=chunk_end,
            char_start=chunk_start_char,
            char_end=chunk_end_char,
        )
        append_token_cues(block, block_index, chunk, result.tokens, cues)

    return total_frames


def write_chapter_wav(
    wav_path: Path,
    blocks: list[Block],
    pipeline: KPipeline,
    args: argparse.Namespace,
) -> tuple[list[AudioChunk], list[TimedCue], float]:
    chunks: list[AudioChunk] = []
    cues: list[TimedCue] = []
    total_frames = 0

    with sf.SoundFile(wav_path, mode="w", samplerate=SAMPLE_RATE, channels=1) as wav:
        for block_index, block in enumerate(blocks):
            block.token_start = len(cues)
            block.start = seconds(total_frames)
            if is_silent_pause_block(block.text):
                total_frames = write_silent_pause_block(
                    wav,
                    block,
                    block_index,
                    chunks,
                    cues,
                    total_frames,
                )
            else:
                total_frames = write_spoken_block(
                    wav,
                    block,
                    block_index,
                    pipeline,
                    args,
                    chunks,
                    cues,
                    total_frames,
                )

            if not block.chunks:
                raise RuntimeError(f"Block {block.id} did not produce any audio chunks")
            block.end = seconds(total_frames)
            block.token_end = len(cues)

    return chunks, cues, seconds(total_frames)


def block_as_manifest(block: Block) -> dict[str, Any]:
    return {
        "id": block.id,
        "kind": block.kind,
        "text": block.text,
        "start": block.start,
        "end": block.end,
        "tokenStart": block.token_start,
        "tokenEnd": block.token_end,
        "chunks": block.chunks,
        "sourceStart": block.source_start,
        "sourceEnd": block.source_end,
    }


def build_manifest(
    args: argparse.Namespace,
    chapter_id: str,
    title: str,
    chapter_path: Path,
    blocks: list[Block],
    chunks: list[AudioChunk],
    cues: list[TimedCue],
    seek_index: list[SeekIndexEntry],
    duration: float,
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "chapter": chapter_id,
        "title": title,
        "source": {
            "markdown": str(chapter_path),
            "blocks": len(blocks),
        },
        "tts": {
            "engine": "kokoro",
            "voice": args.voice,
            "language": args.lang,
            "speed": args.speed,
            "sampleRate": SAMPLE_RATE,
            "pronunciations": [
                {"text": text, "phonemes": phonemes}
                for text, phonemes in PRONUNCIATIONS
            ],
            "silentPauses": [
                {"text": "punctuation-only blocks", "seconds": ELLIPSIS_PAUSE_SECONDS},
            ],
        },
        "audio": {
            "duration": duration,
            "primary": {
                "src": f"./chapter-{chapter_id}.webm",
                "type": 'audio/webm; codecs="opus"',
                "codec": "opus",
                "bitrate": args.opus_bitrate,
            },
            "fallback": {
                "src": f"./chapter-{chapter_id}.m4a",
                "type": 'audio/mp4; codecs="mp4a.40.2"',
                "codec": "aac-lc",
                "bitrate": args.aac_bitrate,
            },
        },
        "playback": {
            "timebase": "seconds",
            "pauseResume": (
                "Use HTMLMediaElement.pause() and play(); highlighting is "
                "recovered from currentTime."
            ),
            "seek": "Set HTMLMediaElement.currentTime, then binary-search cues by start/end.",
            "resumeStorageKey": f"ri:chapter:{chapter_id}:currentTime",
        },
        "blocks": [block_as_manifest(block) for block in blocks],
        "chunks": [chunk.as_manifest() for chunk in chunks],
        "cues": [cue.as_manifest() for cue in cues],
        "seekIndex": [entry.as_manifest() for entry in seek_index],
    }


def publish_chapter_outputs(
    final_paths: ChapterPaths,
    temp_paths: ChapterOutputPaths,
    keep_wav: bool,
) -> None:
    final_paths.manifest.unlink(missing_ok=True)
    temp_paths.webm.replace(final_paths.webm)
    temp_paths.m4a.replace(final_paths.m4a)
    temp_paths.manifest.replace(final_paths.manifest)
    if keep_wav:
        temp_paths.wav.replace(final_paths.wav)
    else:
        temp_paths.wav.unlink()
        final_paths.wav.unlink(missing_ok=True)


def print_chapter_report(paths: ChapterPaths, stats: ChapterStats) -> None:
    print(f"Wrote {paths.manifest}")
    print(f"Wrote {paths.webm}")
    print(f"Wrote {paths.m4a}")
    print(
        "Generated chapter "
        f"{stats.chapter}: {stats.blocks} blocks, {stats.cues} cues, "
        f"{stats.duration:.2f}s audio in {format_elapsed(stats.elapsed)} "
        f"({stats.duration / stats.elapsed:.2f}x realtime)",
        flush=True,
    )


def generate_chapter(
    args: argparse.Namespace,
    chapter_id: str,
    pipeline: KPipeline,
) -> ChapterStats:
    started = time.perf_counter()
    paths = chapter_paths(args, chapter_id)
    paths.out.mkdir(parents=True, exist_ok=True)
    temp_paths = temporary_chapter_paths(paths.out, chapter_id)
    temp_paths.out.mkdir(parents=True, exist_ok=False)

    try:
        title, blocks = parse_chapter(paths.chapter)
        chunks, cues, duration = write_chapter_wav(temp_paths.wav, blocks, pipeline, args)
        encode_audio(
            temp_paths.wav,
            temp_paths.m4a,
            temp_paths.webm,
            args.aac_bitrate,
            args.opus_bitrate,
        )
        seek_index = build_seek_index(cues, chunks, duration, args.seek_step)
        validate_manifest_parts(chapter_id, blocks, chunks, cues, seek_index, duration)

        manifest = build_manifest(
            args,
            chapter_id,
            title,
            paths.chapter,
            blocks,
            chunks,
            cues,
            seek_index,
            duration,
        )
        temp_paths.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        publish_chapter_outputs(paths, temp_paths, args.keep_wav)

        stats = ChapterStats(
            chapter=chapter_id,
            duration=duration,
            blocks=len(blocks),
            cues=len(cues),
            elapsed=time.perf_counter() - started,
        )
        print_chapter_report(paths, stats)
        return stats
    finally:
        shutil.rmtree(temp_paths.out, ignore_errors=True)


def build_seek_index(
    cues: list[TimedCue],
    chunks: list[AudioChunk],
    duration: float,
    step: float,
) -> list[SeekIndexEntry]:
    if step <= 0:
        raise RuntimeError("--seek-step must be greater than 0")
    if not cues:
        raise RuntimeError("Cannot build a seek index without cues")
    starts = [cue.start for cue in cues]
    chunk_lookup = chunks_by_id(chunks)
    seek_index: list[SeekIndexEntry] = []
    slot = 0.0
    last_slot = float(math.floor(duration))
    while slot <= last_slot:
        cue_index = max(0, min(bisect.bisect_right(starts, slot) - 1, len(cues) - 1))
        cue = cues[cue_index]
        chunk = chunk_lookup[cue.chunk_id]
        seek_index.append(
            SeekIndexEntry(
                time=round(slot, 3),
                cue_index=cue_index,
                block_id=cue.block_id,
                block_index=cue.block_index,
                char_start=chunk.char_start + cue.char_start,
            ),
        )
        slot += step
    return seek_index


def load_pipeline(args: argparse.Namespace) -> tuple[KPipeline, float]:
    load_started = time.perf_counter()
    pipeline = KPipeline(lang_code=args.lang, repo_id=KOKORO_REPO_ID, device=args.device)
    return pipeline, time.perf_counter() - load_started


def initialize_worker(args: argparse.Namespace) -> None:
    global WORKER_ARGS
    global WORKER_PIPELINE

    configure_torch_runtime(args)
    WORKER_ARGS = args
    WORKER_PIPELINE, load_elapsed = load_pipeline(args)
    print(
        f"Worker {os.getpid()} loaded Kokoro pipeline in {format_elapsed(load_elapsed)} "
        f"with {torch.get_num_threads()} Torch thread(s).",
        flush=True,
    )


def generate_chapter_in_worker(chapter_id: str) -> ChapterStats:
    if WORKER_ARGS is None or WORKER_PIPELINE is None:
        raise RuntimeError("Chapter worker was not initialized")
    return generate_chapter(WORKER_ARGS, chapter_id, WORKER_PIPELINE)


def selected_chapters_to_generate(args: argparse.Namespace) -> list[str]:
    chapter_ids = parse_chapter_selection(args.chapters)
    if not args.skip_existing:
        return chapter_ids

    skipped = [chapter_id for chapter_id in chapter_ids if generated_assets_exist(args, chapter_id)]
    skipped_ids = set(skipped)
    for chapter_id in skipped:
        print(f"Skipped chapter {chapter_id}; generated assets already exist.")
    return [chapter_id for chapter_id in chapter_ids if chapter_id not in skipped_ids]


def main() -> None:
    args = parse_args()
    validate_runtime_args(args)
    chapter_ids = selected_chapters_to_generate(args)
    if not chapter_ids:
        print("No chapters to generate.")
        return

    batch_started = time.perf_counter()
    if args.jobs == 1:
        intra_threads, interop_threads = configure_torch_runtime(args)
        pipeline, load_elapsed = load_pipeline(args)
        print(
            f"Loaded Kokoro pipeline in {format_elapsed(load_elapsed)} "
            f"with {intra_threads} Torch thread(s) and {interop_threads} inter-op thread(s).",
        )
        stats = [generate_chapter(args, chapter_id, pipeline) for chapter_id in chapter_ids]
    else:
        intra_threads, interop_threads = configured_torch_threads(args)
        load_elapsed = 0.0
        print(
            f"Generating {len(chapter_ids)} chapters with {args.jobs} worker processes, "
            f"{intra_threads} Torch thread(s) per worker, and "
            f"{interop_threads} inter-op thread(s) per worker.",
        )
        context = multiprocessing.get_context("spawn")
        with context.Pool(
            processes=args.jobs,
            initializer=initialize_worker,
            initargs=(args,),
        ) as pool:
            stats = list(pool.imap_unordered(generate_chapter_in_worker, chapter_ids))
    batch_elapsed = time.perf_counter() - batch_started
    total_audio = sum(stat.duration for stat in stats)
    print(
        f"Generated {len(stats)} chapter{'s' if len(stats) != 1 else ''}: "
        f"{total_audio:.2f}s audio in {format_elapsed(batch_elapsed)} "
        f"({total_audio / batch_elapsed:.2f}x realtime"
        f"{model_load_summary(total_audio, batch_elapsed, load_elapsed)}).",
    )


if __name__ == "__main__":
    main()
