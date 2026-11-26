/**
 * The text of a message's content: a string as it is, or the text parts of
 * an array joined (AG-UI 1.0 lets a tool result carry parts too). Media parts
 * add nothing. `contentToText` in `@ag-ui/core` does the same, but this
 * package and the native app import that package for its types only.
 */
export function contentText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter(
            (part): part is { type: 'text'; text: string } =>
                !!part && part.type === 'text' && typeof part.text === 'string',
        )
        .map((part) => part.text)
        .join('');
}
