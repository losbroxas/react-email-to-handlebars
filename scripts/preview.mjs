#!/usr/bin/env node

/**
 * Preview script: compile Handlebars templates with their JSON data to static HTML.
 * Usage: node preview.mjs <sourceDir> [outputDir]
 *   sourceDir  Directory containing .handlebars templates (required). Resolved relative to cwd.
 *   outputDir  Directory for generated .html files (default: "previews"). Resolved relative to cwd.
 * Example: npx react-to-handlebars-preview source/components previews
 */

import Handlebars from "handlebars";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { join, dirname, relative, resolve } from "path";

function getArgs() {
  const sourceDir = process.argv[2];
  const outputDir = process.argv[3] || "previews";
  if (
    sourceDir === undefined ||
    (typeof sourceDir === "string" && sourceDir.trim() === "")
  ) {
    console.error("✗ Error: source directory argument is required.");
    console.error("  Usage: preview.mjs <sourceDir> [outputDir]");
    console.error("  Example: node preview.mjs source/components previews");
    process.exit(1);
  }
  return {
    sourceDir: resolve(process.cwd(), sourceDir),
    outputDir: resolve(process.cwd(), outputDir),
  };
}

function findHandlebarsFiles(dir, fileList = []) {
  const files = readdirSync(dir);
  files.forEach((file) => {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      findHandlebarsFiles(filePath, fileList);
    } else if (file.endsWith(".handlebars")) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

async function compilePreviews() {
  const { sourceDir, outputDir } = getArgs();

  if (!existsSync(sourceDir)) {
    console.error(`✗ Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  console.log("🎨 Compiling Handlebars templates to HTML previews...");

  const files = findHandlebarsFiles(sourceDir);
  let count = 0;

  for (const filePath of files) {
    try {
      const templateContent = readFileSync(filePath, "utf-8");
      const jsonPath1 = filePath + ".json";
      const jsonPath2 = filePath.replace(".handlebars", ".json");

      let data = {};
      if (existsSync(jsonPath1)) {
        data = JSON.parse(readFileSync(jsonPath1, "utf-8"));
      } else if (existsSync(jsonPath2)) {
        data = JSON.parse(readFileSync(jsonPath2, "utf-8"));
      } else {
        continue;
      }

      const template = Handlebars.compile(templateContent);
      const html = template(data);

      const relPath = relative(sourceDir, filePath);
      const outputFilePath = join(
        outputDir,
        relPath.replace(".handlebars", ".html")
      );
      const outputFileDir = dirname(outputFilePath);

      if (!existsSync(outputFileDir)) {
        mkdirSync(outputFileDir, { recursive: true });
      }

      writeFileSync(outputFilePath, html, "utf-8");
      console.log(`✓ Generated: ${relative(process.cwd(), outputFilePath)}`);
      count++;
    } catch (err) {
      console.error(
        `✗ Error processing ${relative(sourceDir, filePath)}:`,
        err.message
      );
    }
  }

  console.log(
    `\n✅ Generated ${count} preview files in ${relative(process.cwd(), outputDir)}`
  );
}

compilePreviews();
