'use strict';

const { inspectPage, screenshotPage, inspectElement, getPageStructure } = require('../../lib/browser.js');

function register(api) {
  api.registerTool({
    name: 'inspect_webpage',
    description:
      'Navigate to a URL and inspect the page for broken links, broken resources (images, scripts, stylesheets), ' +
      'JavaScript console errors, and structural issues. Set check_links to true to follow and verify all internal ' +
      'links on the page.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to inspect (e.g. https://example.com)',
        },
        check_links: {
          type: 'boolean',
          description: 'Whether to follow and verify all internal links on the page (default false)',
        },
      },
      required: ['url'],
    },
    handler: async ({ url, check_links }) => {
      return inspectPage(url, { checkLinks: check_links });
    },
  });

  api.registerTool({
    name: 'screenshot_page',
    description:
      'Take a screenshot of a webpage. Returns a base64-encoded PNG image. ' +
      'Useful for visually inspecting page layout, styling, or rendering issues.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to screenshot',
        },
        full_page: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of just the viewport (default false)',
        },
        viewport_width: {
          type: 'integer',
          description: 'Viewport width in pixels (default 1280)',
        },
        viewport_height: {
          type: 'integer',
          description: 'Viewport height in pixels (default 720)',
        },
      },
      required: ['url'],
    },
    handler: async ({ url, full_page, viewport_width, viewport_height }) => {
      return screenshotPage(url, {
        fullPage: full_page,
        width: viewport_width,
        height: viewport_height,
      });
    },
  });

  api.registerTool({
    name: 'inspect_element',
    description:
      'Inspect a specific element on a webpage using a CSS selector. Returns the element\'s tag, attributes, ' +
      'text content, bounding box, and visibility. Useful for checking whether a specific UI component exists and is visible.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the page containing the element',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to locate the element (e.g. "#login-btn", ".nav-link", "form[action=\'/submit\']")',
        },
      },
      required: ['url', 'selector'],
    },
    handler: async ({ url, selector }) => {
      return inspectElement(url, selector);
    },
  });

  api.registerTool({
    name: 'get_page_structure',
    description:
      'Get the structural breakdown of a webpage: headings, links, images, forms, scripts, and stylesheets. ' +
      'Useful for auditing page structure, checking heading hierarchy, finding images without alt text, and listing external resources.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to analyse',
        },
      },
      required: ['url'],
    },
    handler: async ({ url }) => {
      return getPageStructure(url);
    },
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'browser-inspector';
