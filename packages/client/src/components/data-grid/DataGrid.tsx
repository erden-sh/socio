import { ArrowDown, ArrowUp, ArrowUpDown, MoreHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { nativeSelect } from '../form-fields';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The data grid the People list in Settings introduced (CB-360) and the
 * Schedules list shares (CB-392): a search-and-filter bar, then one row per
 * item, a table on wide screens and a card per item on a phone, each with
 * its actions in a ⋯ menu that names its own row.
 */

/** The bar above a grid: a search box and its filters. */
export function GridToolbar({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-2" role="search" aria-label={label}>
            {children}
        </div>
    );
}

/** The grid's free-text search. */
export function GridSearch({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <Input
            type="search"
            aria-label={label}
            placeholder={label}
            className="h-8 w-full sm:w-56"
            value={value}
            onChange={(e) => onChange(e.target.value)}
        />
    );
}

/** One filter: "<Name>: any" and an option per value. */
export function GridFilter<V extends string>({
    label,
    any,
    value,
    options,
    onChange,
}: {
    /** The select's accessible name ("Status filter"). */
    label: string;
    /** The option for no filter ("Status: any"). */
    any: string;
    value: V | '';
    options: ReadonlyArray<{ value: V; label: string }>;
    onChange: (value: V | '') => void;
}) {
    return (
        <select
            data-slot="native-select"
            aria-label={label}
            className={cn(nativeSelect, 'h-8')}
            value={value}
            onChange={(e) => onChange(e.target.value as V | '')}
        >
            <option value="">{any}</option>
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

/** A row's ⋯ menu. Its trigger says whose actions it holds. */
export function RowActionsMenu({
    name,
    slot,
    title,
    children,
}: {
    /** The row's name: the trigger reads "Actions for <name>". */
    name: string;
    /** The menu content's `data-slot`. */
    slot: string;
    /** The trigger's tooltip. */
    title?: string;
    children: ReactNode;
}) {
    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} title={title}>
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-slot={slot}>
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export interface GridColumn<T> {
    /** A stable id, for keys and sorting. */
    id: string;
    header: ReactNode;
    cell: (row: T) => ReactNode;
    className?: string;
    /** Makes the column's header sort the rows by it. */
    compare?: (a: T, b: T) => number;
}

type Sort = { column: string; dir: 'asc' | 'desc' };

/**
 * The rows: a table from `md` up, a card per row below it. Rows come in
 * their default order; a column with `compare` sorts by it when its header
 * is pressed (again for descending, a third time for the default order).
 */
export function DataGrid<T>({
    label,
    rows,
    rowKey,
    rowProps,
    dimmed,
    columns,
    actions,
    card,
    tableSlot,
    cardsSlot,
}: {
    /** The table's and the card list's accessible name. */
    label: string;
    rows: readonly T[];
    rowKey: (row: T) => string;
    /** Extra attributes on each row and card, such as `data-person`. */
    rowProps?: (row: T) => Record<`data-${string}`, string>;
    /** Grays a row out (deactivated, canceled). */
    dimmed?: (row: T) => boolean;
    columns: ReadonlyArray<GridColumn<T>>;
    /** The row's ⋯ menu, in the last column and the card's corner. */
    actions?: (row: T) => ReactNode;
    /** A row's card on a phone: `head` beside the menu, `body` below. */
    card: (row: T) => { head: ReactNode; body: ReactNode };
    tableSlot: string;
    cardsSlot: string;
}) {
    const [sort, setSort] = useState<Sort>();
    const sortBy = sort && columns.find((column) => column.id === sort.column)?.compare;
    const shown = sortBy ? [...rows].sort((a, b) => (sort.dir === 'asc' ? sortBy(a, b) : sortBy(b, a))) : (rows as T[]);
    const press = (column: string) =>
        setSort((now) =>
            now?.column !== column ? { column, dir: 'asc' } : now.dir === 'asc' ? { column, dir: 'desc' } : undefined,
        );
    return (
        <>
            <Table className="hidden md:table" aria-label={label} data-slot={tableSlot}>
                <TableHeader>
                    <TableRow>
                        {columns.map((column) => {
                            const dir = sort?.column === column.id ? sort.dir : undefined;
                            return (
                                <TableHead
                                    key={column.id}
                                    aria-sort={
                                        column.compare
                                            ? dir === 'asc'
                                                ? 'ascending'
                                                : dir === 'desc'
                                                  ? 'descending'
                                                  : 'none'
                                            : undefined
                                    }
                                >
                                    {column.compare ? (
                                        <button
                                            type="button"
                                            data-slot="grid-sort"
                                            className="inline-flex items-center gap-1 border-0 bg-transparent p-0 font-medium text-inherit shadow-none hover:text-foreground"
                                            onClick={() => press(column.id)}
                                        >
                                            {column.header}
                                            {dir === 'asc' ? (
                                                <ArrowUp aria-hidden className="size-3" />
                                            ) : dir === 'desc' ? (
                                                <ArrowDown aria-hidden className="size-3" />
                                            ) : (
                                                <ArrowUpDown aria-hidden className="size-3 opacity-40" />
                                            )}
                                        </button>
                                    ) : (
                                        column.header
                                    )}
                                </TableHead>
                            );
                        })}
                        {actions && (
                            <TableHead>
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        )}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {shown.map((row) => (
                        <TableRow key={rowKey(row)} {...rowProps?.(row)} className={cn(dimmed?.(row) && 'opacity-60')}>
                            {columns.map((column) => (
                                <TableCell key={column.id} className={column.className}>
                                    {column.cell(row)}
                                </TableCell>
                            ))}
                            {actions && <TableCell className="text-right">{actions(row)}</TableCell>}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
            <ul className="grid gap-2 md:hidden" aria-label={label} data-slot={cardsSlot}>
                {shown.map((row) => {
                    const { head, body } = card(row);
                    return (
                        <li
                            key={rowKey(row)}
                            {...rowProps?.(row)}
                            className={cn('grid gap-2 rounded-md border p-3', dimmed?.(row) && 'opacity-60')}
                        >
                            <span className="flex items-start gap-2">
                                <span className="min-w-0 flex-1">{head}</span>
                                {actions?.(row)}
                            </span>
                            {body}
                        </li>
                    );
                })}
            </ul>
        </>
    );
}
