import { decodeHTML } from "entities";

export function decodeEmailSnippet(value: string): string {
  return decodeHTML(value);
}

export function normalizeEmailText(value: string): string {
  return decodeHTML(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
