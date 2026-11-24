import type { SnippetPart } from '@socio/shared/pages/page-search';

/**
 * A search snippet: plain text, the words the query found marked. The
 * server sends parts, never HTML, so page text can't inject markup.
 */
export function Snippet({ parts }: { parts: readonly SnippetPart[] }) {
    return parts.map((part, index) =>
        part.match ? (
            <mark key={index} className="bg-transparent font-medium text-foreground" data-slot="snippet-match">
                {part.text}
            </mark>
        ) : (
            <span key={index}>{part.text}</span>
        ),
    );
}
