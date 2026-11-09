/** Keep the first '=' as the delimiter so translations may contain equations. */
export function parseHotwords(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").map((line) => {
    const i = line.indexOf("=");
    return i < 1 ? [] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }).filter((entry) => entry.length === 2 && entry[0] && entry[1]).slice(0, 1000));
}
