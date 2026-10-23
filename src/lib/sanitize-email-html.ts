import sanitizeHtml from "sanitize-html";

export function sanitizeEmailHtml(value: string): string {
  // First pass: normalize the HTML to collapse excessive whitespace between inline elements
  let normalized = value
    // Remove newlines and extra spaces between closing and opening tags
    .replace(/>\s+</g, "><")
    // Collapse multiple spaces within text to single space
    .replace(/\s{2,}/g, " ")
    // But preserve intentional paragraph breaks
    .replace(/>\s*\n\s*</g, "><")
    // Replace <br> tags that split short words/numbers (like dates) with spaces
    // More flexible patterns that handle various HTML contexts
    .replace(/([A-Za-z]+)\s*<br\s*\/?>\s*(\d+)/gi, "$1 $2")
    .replace(/(\d+)\s*<br\s*\/?>\s*([A-Za-z]+)/gi, "$1 $2")
    .replace(/([A-Za-z]+)\s*<br\s*\/?>\s*([A-Za-z]+)/gi, "$1 $2");

  return sanitizeHtml(normalized, {
    allowedTags: [
      "a", "b", "blockquote", "br", "caption", "code", "dd", "div", "dl", "dt",
      "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "li", "ol", "p",
      "pre", "s", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
      "th", "thead", "tr", "u", "ul",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      ol: ["start"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
      // Preserve inline content - don't add newlines after br tags
      br: () => ({
        tagName: "br",
        attribs: {},
      }),
    },
  });
}
