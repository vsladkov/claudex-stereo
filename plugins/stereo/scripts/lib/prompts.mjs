import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      // A silently blanked prompt section is worse than a loud failure: a
      // template/call-site typo must surface immediately, not degrade output.
      throw new Error(`Unknown template placeholder {{${key}}}.`);
    }
    return variables[key];
  });
}
