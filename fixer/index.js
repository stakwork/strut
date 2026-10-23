// node-llama-cpp for dictation's fixer (src/audio/fixer.ts), as fixer/
// installs it. The fixer's worker imports this file by its path, so
// node-llama-cpp resolves from here (fixer/node_modules), never from strut's
// own dependencies, which do not have it.
export * from "node-llama-cpp";
