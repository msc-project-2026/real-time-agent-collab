'use strict';

const { inspectPage, screenshotPage, inspectElement, getPageStructure } = require('../../lib/browser.js');

let saveIssue, readSourceFile, saveSuggestion, commitSuggestion, updateSuggestionStatus;
try {
  ({
    saveIssue,
    readSourceFile,
    saveSuggestion,
    commitSuggestion,
    updateSuggestionStatus,
  } = require('../../lib/collab-cache.js'));
} catch {
  saveIssue = null;
  readSourceFile = null;
  saveSuggestion = null;
  commitSuggestion = null;
  updateSuggestionStatus = null;
}

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

  api.registerTool({
    name: 'log_browser_issue',
    description:
      'Log an issue discovered during browser inspection to the project\'s .collab/issues.md file. ' +
      'Use this after inspect_webpage or inspect_element finds a confirmed, actionable problem ' +
      '(broken link, console error, failed resource, missing element). The issue is recorded with ' +
      'Source: browser so it can be distinguished from chat-reported or code-review issues.',
    parameters: {
      type: 'object',
      properties: {
        room_id: {
          type: 'string',
          description: 'The Webex room ID, used to resolve the project repo',
        },
        title: {
          type: 'string',
          description: 'Short title for the issue (e.g. "Broken link on /dashboard")',
        },
        severity: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Issue severity: high for page-breaking problems, medium for broken resources, low for minor issues',
        },
        description: {
          type: 'string',
          description: 'Details about the issue including the affected URL and what was found',
        },
      },
      required: ['room_id', 'title', 'severity', 'description'],
    },
    handler: async ({ room_id, title, severity, description }) => {
      if (!saveIssue) {
        return { ok: false, error: 'collab-cache module not available — issues.md logging is disabled' };
      }
      const result = await saveIssue(room_id, { title, severity, description });
      return { ok: true, id: result.id };
    },
  });

  api.registerTool({
    name: 'read_source_file',
    description:
      'Read the current content of a source file from the project\'s GitHub repository. ' +
      'Always call this before suggest_fix so the proposed content is based on the real file.',
    parameters: {
      type: 'object',
      properties: {
        room_id: {
          type: 'string',
          description: 'The Webex room ID, used to resolve the project repo',
        },
        file_path: {
          type: 'string',
          description: 'Repo-relative path of the file (e.g. src/components/Header.jsx)',
        },
      },
      required: ['room_id', 'file_path'],
    },
    handler: async ({ room_id, file_path }) => {
      if (!readSourceFile) return { ok: false, error: 'collab-cache module not available' };
      const content = await readSourceFile(room_id, file_path);
      if (content === null) return { found: false, file_path };
      return { found: true, file_path, content };
    },
  });

  api.registerTool({
    name: 'suggest_fix',
    description:
      'Propose a fix for an issue found during browser inspection. Saves the suggestion with a unique FIX-XXX ID. ' +
      'After calling this, present the ID and explanation to the team and ask a developer to reply ' +
      '"approve FIX-XXX" to commit it or "reject FIX-XXX" to discard it. ' +
      'Always call read_source_file first so proposed_content reflects the actual current file.',
    parameters: {
      type: 'object',
      properties: {
        room_id: {
          type: 'string',
          description: 'The Webex room ID, used to resolve the project repo',
        },
        file_path: {
          type: 'string',
          description: 'Repo-relative path of the file to fix (e.g. src/components/Nav.jsx)',
        },
        proposed_content: {
          type: 'string',
          description: 'The complete new content for the file after the fix is applied',
        },
        explanation: {
          type: 'string',
          description: 'One or two sentences describing what the fix does and why it resolves the issue',
        },
      },
      required: ['room_id', 'file_path', 'proposed_content', 'explanation'],
    },
    handler: async ({ room_id, file_path, proposed_content, explanation }) => {
      if (!saveSuggestion) return { ok: false, error: 'collab-cache module not available, fix suggestions are disabled' };
      const suggestion = await saveSuggestion(room_id, {
        filePath: file_path,
        proposedContent: proposed_content,
        explanation,
      });
      return { ok: true, id: suggestion.id, filePath: suggestion.filePath, explanation: suggestion.explanation };
    },
  });

  api.registerTool({
    name: 'commit_fix',
    description:
      'Apply an approved fix by committing the proposed file content to GitHub. ' +
      'Only call this after a developer has explicitly replied "approve FIX-XXX".',
    parameters: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'The Webex room ID' },
        suggestion_id: { type: 'string', description: 'The suggestion ID to apply (e.g. FIX-001)' },
      },
      required: ['room_id', 'suggestion_id'],
    },
    handler: async ({ room_id, suggestion_id }) => {
      if (!commitSuggestion) return { ok: false, error: 'collab-cache module not available' };
      try {
        const result = await commitSuggestion(room_id, suggestion_id);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  });

  api.registerTool({
    name: 'reject_fix',
    description:
      'Discard a pending fix suggestion without committing anything. ' +
      'Call this when a developer replies "reject FIX-XXX".',
    parameters: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'The Webex room ID' },
        suggestion_id: { type: 'string', description: 'The suggestion ID to reject (e.g. FIX-001)' },
      },
      required: ['room_id', 'suggestion_id'],
    },
    handler: async ({ room_id, suggestion_id }) => {
      if (!updateSuggestionStatus) return { ok: false, error: 'collab-cache module not available' };
      try {
        await updateSuggestionStatus(room_id, suggestion_id, 'rejected');
        return { ok: true, id: suggestion_id };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'browser-inspector';
