export default {
  default: {
    paths: ["features/**/*.feature"],
    import: ["features/step-definitions/listening.steps.mjs"],
    format: ["progress"],
    publishQuiet: true
  }
};
