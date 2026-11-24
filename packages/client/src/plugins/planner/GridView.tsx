import { POST_STATUS_LABEL, formatZonedLabel } from '@socio/shared/planner';

import { accountColor } from './dates';
import type { PlannedPost } from './types';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function GridView({ posts, onOpen }: { posts: PlannedPost[]; onOpen: (post: PlannedPost) => void }) {
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tag</TableHead>
                    <TableHead>Post</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {posts.map((post) => (
                    <TableRow
                        key={post.id}
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() => onOpen(post)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onOpen(post);
                            }
                        }}
                    >
                        <TableCell className="whitespace-nowrap">{formatZonedLabel(post.plannedAt)}</TableCell>
                        <TableCell>
                            <span className="inline-flex items-center gap-2">
                                <span
                                    className="size-2 rounded-full"
                                    style={{ background: accountColor(post.account) }}
                                    aria-hidden="true"
                                />
                                @{post.account}
                            </span>
                        </TableCell>
                        <TableCell>
                            <Badge variant="outline">{POST_STATUS_LABEL[post.status]}</Badge>
                        </TableCell>
                        <TableCell className="max-w-32 truncate">{post.topic}</TableCell>
                        <TableCell className="max-w-sm whitespace-normal">
                            <span className="line-clamp-2">{post.parts[0]?.text}</span>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}
