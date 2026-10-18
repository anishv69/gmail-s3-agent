import sanitizeHtml from "sanitize-html";

export function sanitizeEmailHtml(value: string): string {
  return sanitizeHtml(value, {
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
    },
  });
}
