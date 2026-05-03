@web @listening
Feature: Chapter listening
  The listener can hear a selected chapter, move through it, and return without
  losing useful progress.

  Background:
    Given chapter 1 is ready to listen

  Rule: Audio starts and stops from the transport
    Scenario: Selected chapter is ready for playback
      Then chapter 1 can be played in supported browsers

    Scenario: Listener starts the chapter
      When the listener starts playback
      Then the transport shows active playback

    Scenario: Listener pauses an active chapter
      Given playback has already started
      When the listener pauses playback
      Then playback is paused

  Rule: Transcript follows listening position
    Scenario: Playback reaches a spoken passage
      When playback reaches 10 seconds
      Then the transcript follows "Old bastard Fang"

    Scenario: Playback advances the visible transcript
      Given playback has already started
      When playback reaches 30 seconds
      Then the transcript follows "Fang Yuan you damn demon"
      And the followed passage begins near the reading start

    Scenario: Manual reading position is respected during playback
      Given playback has already started
      When the listener manually reviews another passage
      And playback reaches 30 seconds
      Then the listening view remains under the listener's control

    Scenario: Playback reaches a narrative pause
      When playback reaches the first narrative pause
      Then the transcript follows the narrative pause

  Rule: Listener can move through the chapter
    Scenario: Listener jumps to a passage
      When the listener jumps to 30 seconds
      Then listening is positioned at "0:30"
      And the transcript follows "Fang Yuan you damn demon"
      And the followed passage begins near the reading start

    Scenario: Listener jumps to the chapter opening
      Given listening is positioned at 30 seconds
      When the listener jumps to 0 seconds
      Then listening is positioned at "0:00"
      And the chapter opening begins near the reading start

    Scenario: Listener skips backward
      Given listening is positioned at 30 seconds
      When the listener skips backward
      Then listening is positioned at "0:15"

    Scenario: Listener skips back to the chapter opening
      Given listening is positioned at 10 seconds
      When the listener skips backward
      Then listening is positioned at "0:00"
      And the chapter opening begins near the reading start

    Scenario: Listener skips forward
      Given listening is positioned at 15 seconds
      When the listener skips forward
      Then listening is positioned at "0:45"
      And the transcript follows "Demon, 300 years ago"

  Rule: Progress is retained appropriately
    Scenario: Listener returns to saved progress
      Given the listener previously stopped at 30 seconds in chapter 1
      When the listener returns to chapter 1
      Then listening is positioned at "0:30"
      And the transcript follows "Fang Yuan you damn demon"

    Scenario: Completed chapter resets future listening
      Given listening is positioned at 120 seconds
      When the chapter finishes
      Then the chapter is shown as complete
      And a future visit starts from the beginning

    Scenario: Listener replays a completed chapter
      Given the chapter has already finished
      When the listener replays the chapter
      Then playback restarts from the beginning

  Rule: The listening surface remains readable
    Scenario: Common screen sizes remain usable
      Then the listening interface fits common screens
