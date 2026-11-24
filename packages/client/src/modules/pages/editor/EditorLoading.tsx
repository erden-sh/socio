/** The editor's place while its chunk loads (and on the server). */
export function EditorLoading() {
    return (
        <div data-slot="editor-loading" className="py-[35px] text-sm text-muted-foreground">
            Loading editor…
        </div>
    );
}
