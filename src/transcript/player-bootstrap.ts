const MAX_SOURCE_LENGTH = 8_000_000;

/**
 * Extracts a JSON object assigned to one of YouTube's bootstrap globals without evaluating page
 * script. Background tabs can expose the serialized HTML before YouTube executes that script.
 */
export function parseAssignedJson(sources: Iterable<string>, identifiers: string[]): unknown | undefined {
  for (const source of sources) {
    if (!source || source.length > MAX_SOURCE_LENGTH) continue;
    for (const identifier of identifiers) {
      let marker = source.indexOf(identifier);
      while (marker >= 0) {
        const start = source.indexOf("{", marker + identifier.length);
        if (start < 0) break;
        const json = balancedObject(source, start);
        if (json) {
          try {
            return JSON.parse(json);
          } catch {
            // A different mention of the identifier may be followed by the real assignment.
          }
        }
        marker = source.indexOf(identifier, marker + identifier.length);
      }
    }
  }
  return undefined;
}

function balancedObject(source: string, start: number): string | undefined {
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (string) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') string = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}
