/** Where an image's bytes come from: this conversation's attachments only. */
export interface ToolImageSource {
    /** The most bytes one image may have for the model. */
    maxBytes: number;
    /**
     * The stored image's size, never the one a result names; undefined when
     * it was deleted or is not this conversation's.
     */
    size(id: string): Promise<number | undefined>;
    /** The image's bytes; undefined when it was deleted or is not this conversation's. */
    load(id: string): Promise<{ data: Uint8Array; mediaType: string } | undefined>;
}
