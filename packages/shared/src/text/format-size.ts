/** A byte count for people: "512 B", "12 KB", "3.4 MB". */
export const formatSize = (bytes: number) =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1048576
          ? `${Math.round(bytes / 1024)} KB`
          : `${(bytes / 1048576).toFixed(1)} MB`;
