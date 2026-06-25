# Browser Inspector

You have access to browser inspection tools that let you navigate to web pages, inspect their structure, and identify issues. Use these tools to help the team verify the web app is working correctly.

## When to Use

- A team member shares a URL and asks you to check it
- Someone reports a broken page, link, or visual issue
- You are asked to audit the web app for problems
- A deployment or change has been made and someone wants a quick smoke test

Do **not** proactively browse URLs unless asked. Only inspect pages when a user provides or references a URL.

## Available Tools

### `inspect_webpage`
The primary inspection tool. Use this first when asked to check a page. It reports:
- Broken resources (images, scripts, stylesheets returning 4xx/5xx)
- Failed network requests
- JavaScript console errors
- Page structure (links, images, headings, forms, buttons)

Set `check_links: true` when the user specifically asks about broken links — this follows every internal link and checks for 404s, so it takes longer.

### `screenshot_page`
Takes a visual screenshot of the page. Use when:
- The user asks what the page looks like
- You need to verify layout or styling
- A visual issue has been reported

### `inspect_element`
Targets a specific element by CSS selector. Use when:
- The user references a specific button, form, or component
- You need to verify whether a particular element exists and is visible
- Following up on a broken element found by `inspect_webpage`

### `get_page_structure`
Returns a structural audit of the page: headings, links, images, forms, scripts, stylesheets. Use when:
- The user asks for an overview of page structure
- You need to check heading hierarchy or find missing alt text
- You want to list all external resources the page loads

## Reporting Findings

When you find issues, report them clearly and concisely:
- State what is broken and where (URL, element)
- Distinguish between critical issues (page won't load, JS errors, broken forms) and minor ones (missing alt text, heading order)
- If multiple issues are found, group them by severity

### Logging to `.collab/issues.md`
When you find significant issues (broken links, console errors, failed resources), log them to `.collab/issues.md` using the `append_to_collab_file` tool with `Source: browser`. This ensures browser-discovered issues are tracked alongside issues from chat and source code review.

Only log confirmed, actionable issues — do not log minor warnings or informational findings unless the user asks you to.

## Limitations

- You can only inspect publicly accessible URLs or URLs reachable from the server
- Navigation to localhost and private IP ranges is blocked for security
- Pages that require authentication may not render correctly
- Screenshots are from a headless browser and may not perfectly match a real browser
