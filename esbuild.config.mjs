import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFileSync } from "fs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    "onnxruntime-node",
  ],
  alias: {
    // Swap WASM-based runtime for native Node bindings
    // onnxruntime-web can't load WASM in Obsidian's plugin protocol
    "onnxruntime-web": "onnxruntime-node",
  },
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  jsx: "automatic",
  jsxImportSource: "react",
});

// Copy floating recorder HTML alongside the bundle
try {
  copyFileSync("src/floatingRecorder.html", "floatingRecorder.html");
} catch { /* file may not exist yet */ }


if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
