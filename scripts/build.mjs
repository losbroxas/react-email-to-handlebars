#!/usr/bin/env node

/**
 * Build script to convert React components to Handlebars templates.
 * Usage: node build.mjs <dir>
 *   dir  Directory containing .tsx/.jsx components (required). Resolved relative to cwd.
 *        Output .handlebars files are written next to sources.
 * Example: npx react-to-handlebars source/components
 *
 * Uses the consumer's React for rendering so the script and the bundled component
 * share one React instance (avoids "Objects are not valid as a React child" when
 * the script runs from the package and the bundle resolves react from the consumer).
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";
import { build as esbuild } from "esbuild";
import { format, resolveConfig } from "prettier";

const require = createRequire(import.meta.url);

/** Resolve React and react-dom/server from the consumer's node_modules so the bundle and the script use the same React instance. */
function getConsumerReact(cwd) {
  const consumerRequire = createRequire(
    pathToFileURL(join(cwd, "package.json")).href,
  );
  return {
    React: consumerRequire("react"),
    renderToStaticMarkup:
      consumerRequire("react-dom/server").renderToStaticMarkup,
  };
}

function getComponentsDir() {
  const arg = process.argv[2];
  if (arg === undefined || (typeof arg === "string" && arg.trim() === "")) {
    console.error("✗ Error: directory argument is required.");
    console.error("  Usage: build.mjs <dir>");
    console.error("  Example: node build.mjs source/components");
    process.exit(1);
  }
  return resolve(process.cwd(), arg);
}

function findReactFiles(dir, fileList = []) {
  const files = require("fs").readdirSync(dir);
  files.forEach((file) => {
    const filePath = join(dir, file);
    const stat = require("fs").statSync(filePath);
    if (stat.isDirectory()) findReactFiles(filePath, fileList);
    else if (file.endsWith(".jsx") || file.endsWith(".tsx"))
      fileList.push(filePath);
  });
  return fileList;
}

function processRecursiveTags(html) {
  let processed = html;

  // Replace innermost hb-if first
  let changed = true;
  while (changed) {
    changed = false;
    const next = processed.replace(
      /<hb-if(?:\s+condition="([^"]*)")?[^>]*>((?:(?!<hb-if)[\s\S])*?)<\/hb-if>/g,
      (m, cond, content) => {
        changed = true;

        let u = cond;
        if (u) {
          u = u
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"');

          // Strip {{ }} if present (e.g. from marker replacement)
          if (u.startsWith("{{") && u.endsWith("}}")) {
            u = u.slice(2, -2).trim();
          }
        }

        // Check if u is effectively empty (undefined, null, empty string)
        if (!u || u.trim() === "") {
          // Check if there is an else block
          const elseMatch = content.match(/<hb-else>([\s\S]*?)<\/hb-else>/);
          if (elseMatch) {
            return elseMatch[1];
          }
          // If no else block and no condition, treat as hidden
          return "";
        }

        const parts = u.includes("&&")
          ? u
              .split("&&")
              .map((p) => `{{#if ${p.trim()}}}`)
              .join("")
          : `{{#if ${u}}}`;
        const ends = u.includes("&&")
          ? u
              .split("&&")
              .map(() => `{{/if}}`)
              .join("")
          : `{{/if}}`;
        const elseMatch = content.match(/<hb-else>([\s\S]*?)<\/hb-else>/);
        if (elseMatch) {
          const ifPart = content.substring(0, elseMatch.index);
          const elseBody = elseMatch[1];
          const afterPart = content.substring(
            elseMatch.index + elseMatch[0].length,
          );
          return `${parts}${ifPart}{{else}}${elseBody}${afterPart}${ends}`;
        }
        return `${parts}${content}${ends}`;
      },
    );
    processed = next;
    if (!changed) break;
  }

  changed = true;
  while (changed) {
    changed = false;
    const next = processed.replace(
      /<hb-each\s+array="([^"]+)"(?:\s+itemVar="([^"]+)")?[^>]*>((?:(?!<hb-each)[\s\S])*?)<\/hb-each>/g,
      (m, arr, v, content) => {
        changed = true;
        const tag = v ? `{{#each ${arr} as |${v}|}}` : `{{#each ${arr}}}`;
        const replacement = v || "this";
        const pat = new RegExp(
          `${arr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\[0\\]`,
          "g",
        );
        return `${tag}${content.replace(pat, replacement)}{{/each}}`;
      },
    );
    processed = next;
    if (!changed) break;
  }

  return processed;
}

function postProcessHandlebars(html, propUsages) {
  let processed = html;
  const sortedMarkers = Array.from(propUsages.keys()).sort(
    (a, b) => b.length - a.length,
  );
  for (const marker of sortedMarkers) {
    const path = propUsages.get(marker);
    processed = processed.split(marker).join(`{{${path}}}`);
  }
  return processRecursiveTags(processed);
}

async function buildTemplate(componentPath, componentsDir, consumerReact) {
  const { React, renderToStaticMarkup } = consumerReact;
  try {
    const renderedPropUsages = new Map();
    const tempFile = componentPath.replace(/\.tsx$/, ".mjs");
    await esbuild({
      entryPoints: [componentPath],
      bundle: true,
      outfile: tempFile,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      loader: { ".tsx": "tsx", ".ts": "ts" },
      target: "es2020",
      external: ["react", "react-dom"],
      define: { "process.env.IS_HANDLEBARS_BUILD": '"true"' },
      write: true,
    });
    try {
      process.env.IS_HANDLEBARS_BUILD = "true";
      const componentModule = await import(
        pathToFileURL(tempFile).href + "?t=" + Date.now()
      );
      const Component = componentModule.default || componentModule;

      const createDataWithMarkers = (obj, path = "") => {
        if (Array.isArray(obj)) {
          return [
            createDataWithMarkers(obj[0] || {}, path ? `${path}.[0]` : "[0]"),
          ];
        }
        if (obj && typeof obj === "object" && obj.$$typeof === undefined) {
          const newObj = {};
          for (const key of Object.keys(obj)) {
            newObj[key] = createDataWithMarkers(
              obj[key],
              path ? `${path}.${key}` : key,
            );
          }
          return newObj;
        }
        const marker = `__PROP_${path.replace(/[.[\]]/g, "_")}__`;
        renderedPropUsages.set(marker, path);
        return marker;
      };

      const markerProps = createDataWithMarkers(Component.PreviewProps || {});
      const html = renderToStaticMarkup(
        React.createElement(Component, markerProps),
      );

      // Strip normal HTML comments but preserve conditional comments (e.g. <!--[if mso]>...<![endif]-->)
      let processed = html
        .replace(/<!--(?!\[)[\s\S]*?-->/g, "")
        .replace(/data-id="[^"]*"/g, "");

      // Yahoo fix marker
      const hasYahooFix = processed.includes("<yahoo-fix></yahoo-fix>");
      processed = processed.replace(/<yahoo-fix><\/yahoo-fix>/g, "");

      processed = postProcessHandlebars(processed, renderedPropUsages);

      processed = processed.replace(
        /<table([^>]+)style="([^"]*max-width:700px[^"]*)"/g,
        (match, attrs, style) => {
          if (!attrs.includes("width="))
            return `<table${attrs}width="700" style="${style}"`;
          return match;
        },
      );

      let finalHtml = processed;
      const hasConditionalComments =
        processed.includes("<!--[if") || processed.includes("<![endif]");
      if (!hasConditionalComments || process.argv.includes("--format")) {
        try {
          const prettierConfig = await resolveConfig(componentPath);
          finalHtml = await format(processed, {
            ...prettierConfig,
            parser: "html",
            printWidth: 120,
          });
        } catch (e) {
          console.error(`✗ Error formatting ${componentPath}:`, e.message);
        }
      }

      const msoStart =
        '<!--[if mso]><table align="center" border="0" cellpadding="0" cellspacing="0" width="700" style="width:700px;"><tr><td align="center" valign="top" width="700" style="width:700px;"><![endif]-->';
      const msoEnd = "<!--[if mso]></td></tr></table><![endif]-->";
      const dpiSettings =
        "<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG /><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->";

      finalHtml = finalHtml.replace(/!!MSO_GHOST_START!!/g, msoStart);
      finalHtml = finalHtml.replace(/!!MSO_GHOST_END!!/g, msoEnd);
      finalHtml = finalHtml.replace(/!!MSO_DPI_SETTINGS!!/g, dpiSettings);
      finalHtml = finalHtml.replace(/>\s*>+<!--/g, "><!--");
      finalHtml = finalHtml.replace(/-->\s*<+/g, "--><");

      finalHtml = finalHtml.replace(
        /<body/g,
        '<body id="body" bgcolor="#F1EFE5"',
      );
      const oldDocType =
        '<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="nl">';

      if (finalHtml.includes("<!DOCTYPE")) {
        finalHtml = finalHtml.replace(/<!DOCTYPE[^>]*>/, oldDocType);
      } else {
        finalHtml = oldDocType + "\n" + finalHtml;
      }

      // Yahoo fix placement (before the main head)
      if (hasYahooFix) {
        finalHtml = finalHtml.replace(/<head>/, "<head></head>\n<head>");
      }

      finalHtml = finalHtml.replace(/<html[^>]*>/g, (m, offset) =>
        offset < 50 ? m : "",
      );
      if (!finalHtml.trim().endsWith("</html>"))
        finalHtml = finalHtml.trim() + "\n</html>";
      finalHtml = finalHtml.replace(/<\/html>\s*<\/html>/g, "</html>");
      finalHtml = finalHtml
        .replace(/xmlnsv=/g, "xmlns:v=")
        .replace(/xmlnso=/g, "xmlns:o=");

      const relativePath = componentPath
        .replace(componentsDir, "")
        .replace(/^\//, "");
      const outputPath = join(
        componentsDir,
        relativePath
          .replace(/\.tsx$/, ".handlebars")
          .replace(/\.jsx$/, ".handlebars"),
      );
      if (!existsSync(dirname(outputPath)))
        mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, finalHtml, "utf-8");
      console.log(
        `✓ Built: ${relativePath} → ${relativePath.replace(/\.tsx$/, ".handlebars")}`,
      );
    } finally {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  } catch (error) {
    console.error(`✗ Error building ${componentPath}:`, error.message);
  }
}

async function build() {
  const cwd = process.cwd();
  const srcDir = getComponentsDir();
  if (!existsSync(srcDir)) {
    console.error(`✗ Directory not found: ${srcDir}`);
    process.exit(1);
  }
  const consumerReact = getConsumerReact(cwd);
  const reactFiles = findReactFiles(srcDir);
  for (const file of reactFiles) {
    await buildTemplate(file, srcDir, consumerReact);
  }
}
build().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
