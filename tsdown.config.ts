/** Standalone Host ESM and DSH browser-factory builds. */
import { readFile } from "node:fs/promises";
import { basename, resolve, dirname } from "node:path";
import { defineConfig } from "tsdown";
import { transform } from "lightningcss";
const id = "dsh-daily-planner";
const browserExternals = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
]);
export default defineConfig([
  {
    entry: { index: "src/host/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    clean: true,
    dts: false,
    deps: { neverBundle: [/^@deepseek-ai\//, "zod"] },
  },
  {
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    clean: false,
    dts: false,
    sourcemap: true,
    deps: {
      neverBundle: (s) => browserExternals.has(s),
      alwaysBundle: (s) => !browserExternals.has(s),
    },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "planner-css-modules",
        resolveId(source, importer) {
          if (source.endsWith(".module.css") && importer)
            return (
              "\0planner-css:" + resolve(dirname(importer), source) + ".mjs"
            );
        },
        async load(source) {
          if (!source.startsWith("\0planner-css:")) return null;
          const path = source.slice("\0planner-css:".length, -4);
          const result = transform({
            filename: basename(path),
            code: Buffer.from(await readFile(path)),
            cssModules: { pattern: "dp_[local]_[hash]" },
            minify: true,
          });
          const names = Object.fromEntries(
            Object.entries(result.exports ?? {}).map(([key, value]) => [
              key,
              value.name,
            ]),
          );
          return (
            "const key=" +
            JSON.stringify(id + "/" + basename(path)) +
            "; if(!document.querySelector('style[data-plugin-css=\"'+key+'\"]')){const tag=document.createElement(\"style\");tag.dataset.plugin=" +
            JSON.stringify(id) +
            ";tag.dataset.pluginCss=key;tag.textContent=" +
            JSON.stringify(result.code.toString()) +
            ";document.head.appendChild(tag)};export default " +
            JSON.stringify(names) +
            ";"
          );
        },
      },
    ],
    outputOptions: {
      entryFileNames: "client.js",
      banner:
        'window.__ModuleLoader__.load({id:"' + id + '",factory:(require)=>{',
      intro: "var module={exports:{}};var exports=module.exports;",
      footer: "return module.exports;}});",
    },
  },
]);
