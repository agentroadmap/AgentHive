import assert from "node:assert";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import MermaidMarkdown from "../../src/web/components/MermaidMarkdown.tsx";

describe("MermaidMarkdown", () => {
	it("renders angle-bracket type strings without throwing", () => {
		const source =
			"Implemented contracts: getDishesByMenu(String menuId) -> Result<List<MenuItem>>";

		assert.doesNotThrow(() =>
			renderToString(<MermaidMarkdown source={source} />),
		);

		const html = renderToString(<MermaidMarkdown source={source} />);
		assert.ok(html.includes("Result&lt;List&lt;MenuItem&gt;&gt;"));
	});

	it("keeps markdown rendering functional for normal content", () => {
		const source = "## Heading\n\nRegular **markdown** content.";
		const html = renderToString(<MermaidMarkdown source={source} />);

		assert.ok(html.includes("Heading"));
		assert.ok(html.includes("<strong>markdown</strong>"));
	});

	it("preserves non-http autolinks and email autolinks", () => {
		const source = "Links: <ftp://example.com/file> and <foo@example.com>";
		const html = renderToString(<MermaidMarkdown source={source} />);

		assert.ok(html.includes('href="ftp://example.com/file"'));
		assert.ok(html.includes('href="mailto:foo@example.com"'));
	});
});
