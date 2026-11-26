import { useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';

import {
    COLOR_MODES,
    DEFAULT_THEME_ID,
    THEME_IDS,
    THEME_LABELS,
    type ColorMode,
    type ThemeId,
} from '@socio/shared/settings/appearance';

import logo from '../../public/favicon.svg?inline';

import { PeopleDesk } from './people-desk';

import { nativeSelect } from '@/components/form-fields';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import {
    Sidebar,
    SidebarContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/shell/theme';
import './gallery.css';

const people = [
    { name: 'Imani Brooks', role: 'Admin', status: 'Active' },
    { name: 'Li Wei', role: 'Member', status: 'Active' },
    { name: 'Samira Al-Khatib Fernández', role: 'Member', status: 'Invited' },
];

function Sample({ name, children }: { name: string; children: ReactNode }) {
    return (
        <section className="gallery-sample" data-sample={name}>
            <h4>{name}</h4>
            {children}
        </section>
    );
}

function Fields() {
    const [email, setEmail] = useState('name@');
    const invalid = !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    return (
        <>
            <Sample name="Button">
                <div className="gallery-flow">
                    <Button onClick={() => toast.success('Changes confirmed')}>Confirm changes</Button>
                    <Button variant="outline" onClick={() => toast.info('Changes cancelled')}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={() => setEmail('')}>
                        Clear email
                    </Button>
                    <Button disabled>Unavailable</Button>
                </div>
            </Sample>
            <Sample name="Input">
                <label htmlFor="workspace-name">Workspace name</label>
                <Input id="workspace-name" defaultValue="Studio team" />
                <label htmlFor="email">Email</label>
                <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    aria-invalid={invalid}
                    aria-describedby="email-hint"
                />
                <p className={invalid ? 'text-destructive' : 'text-muted-foreground'} id="email-hint">
                    {invalid ? 'Enter a valid email address.' : 'Use a work email address.'}
                </p>
            </Sample>
            <Sample name="Textarea">
                <label htmlFor="note">Review note</label>
                <Textarea id="note" defaultValue="Confirm which roles need access to the workspace." />
            </Sample>
            <Sample name="Select">
                <label htmlFor="role">Role</label>
                <Select defaultValue="member">
                    <SelectTrigger id="role">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                </Select>
            </Sample>
            <Sample name="Checkbox">
                <label className="gallery-flow">
                    <Checkbox defaultChecked /> Notify members
                </label>
                <label className="gallery-flow">
                    <Checkbox defaultChecked="indeterminate" /> Select all members
                </label>
            </Sample>
            <Sample name="Switch">
                <label className="gallery-flow">
                    <Switch defaultChecked /> Require review
                </label>
            </Sample>
        </>
    );
}

function DirectoryTable() {
    const [descending, setDescending] = useState(false);
    const sortedPeople = descending ? [...people].reverse() : people;
    return (
        <Table aria-label="People directory">
            <TableHeader>
                <TableRow>
                    <TableHead scope="col" aria-sort={descending ? 'descending' : 'ascending'}>
                        <Button variant="ghost" size="sm" onClick={() => setDescending(!descending)}>
                            Name
                        </Button>
                    </TableHead>
                    <TableHead scope="col">Role</TableHead>
                    <TableHead scope="col">Status</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {sortedPeople.map((person) => (
                    <TableRow key={person.name}>
                        <TableCell className="whitespace-normal [overflow-wrap:anywhere]">{person.name}</TableCell>
                        <TableCell>{person.role}</TableCell>
                        <TableCell>
                            <Badge variant={person.status === 'Active' ? 'success' : 'info'}>{person.status}</Badge>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

function Displays() {
    return (
        <>
            <Sample name="Badge">
                <div className="gallery-flow">
                    <Badge variant="success">Active</Badge>
                    <Badge variant="info">Invited</Badge>
                    <Badge variant="warning">Invite expired</Badge>
                    <Badge variant="destructive">Removed</Badge>
                </div>
            </Sample>
            <Sample name="Avatar">
                <Avatar shape="rounded" aria-label="Imani Brooks">
                    <AvatarFallback aria-hidden="true">IB</AvatarFallback>
                </Avatar>
            </Sample>
            <Sample name="Skeleton">
                <div className="gallery-flow" aria-busy="true" aria-label="Loading a person" role="status">
                    <Skeleton aria-hidden="true" className="size-8 rounded-full" />
                    <div className="grid gap-1.5" aria-hidden="true">
                        <Skeleton className="h-3 w-28" />
                        <Skeleton className="h-2 w-20" />
                    </div>
                </div>
            </Sample>
            <Sample name="Card">
                <Card className="gap-3 py-4">
                    <CardHeader>
                        <CardTitle>InternationalFieldResearchAndDesignStudio</CardTitle>
                        <CardDescription>Private workspace</CardDescription>
                        <CardAction>
                            <Button size="sm" variant="outline" onClick={() => toast.info('Access details selected')}>
                                View access
                            </Button>
                        </CardAction>
                    </CardHeader>
                </Card>
            </Sample>
            <Sample name="Separator">
                <div className="gallery-flow h-5">
                    <span>Workspace</span>
                    <Separator orientation="vertical" />
                    <span>People</span>
                </div>
            </Sample>
            <Sample name="ScrollArea">
                <ScrollArea className="h-21 rounded-md border" tabIndex={0} aria-label="Recent activity" role="region">
                    <ul className="grid gap-2 px-3 py-2">
                        {[
                            'Invitation sent',
                            'Member joined',
                            'Access reviewed',
                            'Group updated',
                            'Member deactivated',
                        ].map((entry) => (
                            <li key={entry}>{entry}</li>
                        ))}
                    </ul>
                </ScrollArea>
            </Sample>
            <Sample name="Table">
                <DirectoryTable />
            </Sample>
            <Sample name="Toaster">
                <div className="gallery-flow">
                    <Button variant="outline" onClick={() => toast.success('Workspace settings saved')}>
                        Show confirmation
                    </Button>
                    <Button variant="outline" onClick={() => toast.error('Could not update access. Try again.')}>
                        Show error
                    </Button>
                </div>
            </Sample>
        </>
    );
}

function Navigation() {
    const [active, setActive] = useState('People');
    return (
        <>
            <Sample name="Breadcrumb">
                <Breadcrumb>
                    <BreadcrumbList>
                        <BreadcrumbItem>Workspace</BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                            <BreadcrumbPage>People</BreadcrumbPage>
                        </BreadcrumbItem>
                    </BreadcrumbList>
                </Breadcrumb>
            </Sample>
            <Sample name="Tabs">
                <Tabs defaultValue="people">
                    <TabsList aria-label="Directory sections">
                        <TabsTrigger value="people">People</TabsTrigger>
                        <TabsTrigger value="groups">Groups</TabsTrigger>
                    </TabsList>
                    <TabsContent value="people">Individual members and invitations</TabsContent>
                    <TabsContent value="groups">Membership and role assignments</TabsContent>
                </Tabs>
            </Sample>
            <Sample name="Collapsible">
                <Collapsible className="grid gap-2">
                    <CollapsibleTrigger asChild>
                        <Button variant="outline">Access details</Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>Visible to members of the workspace.</CollapsibleContent>
                </Collapsible>
            </Sample>
            <Sample name="Sidebar">
                <SidebarProvider className="min-h-0" style={{ '--sidebar-width': '100%' } as CSSProperties}>
                    <Sidebar collapsible="none" className="overflow-hidden rounded-md border">
                        <SidebarContent className="p-1.5">
                            <SidebarMenu>
                                {['People', 'Spaces', 'Activity'].map((label) => (
                                    <SidebarMenuItem key={label}>
                                        <SidebarMenuButton isActive={active === label} onClick={() => setActive(label)}>
                                            {label}
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                ))}
                            </SidebarMenu>
                        </SidebarContent>
                    </Sidebar>
                </SidebarProvider>
            </Sample>
            <Sample name="Command">
                <Command label="Workspace commands" defaultValue="Find a person" className="border">
                    <CommandInput placeholder="Find a command…" />
                    <CommandList>
                        <CommandEmpty>No matching commands</CommandEmpty>
                        <CommandItem onSelect={() => toast.info('People selected')}>Find a person</CommandItem>
                        <CommandItem onSelect={() => toast.info('Groups selected')}>Create a group</CommandItem>
                    </CommandList>
                </Command>
            </Sample>
        </>
    );
}

function Overlays() {
    return (
        <>
            <Sample name="Dialog">
                <Dialog>
                    <DialogTrigger asChild>
                        <Button variant="outline">Open invitation form</Button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Invite people</DialogTitle>
                            <DialogDescription>Add someone to Studio team.</DialogDescription>
                        </DialogHeader>
                        <label htmlFor="invite-email">Email</label>
                        <Input id="invite-email" type="email" />
                    </DialogContent>
                </Dialog>
            </Sample>
            <Sample name="AlertDialog">
                <AlertDialog>
                    <AlertDialogTrigger asChild>
                        <Button variant="outline">Remove invitation</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Remove this invitation?</AlertDialogTitle>
                            <AlertDialogDescription>The invitation link will stop working.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Keep invitation</AlertDialogCancel>
                            <AlertDialogAction onClick={() => toast.success('Invitation removed')}>
                                Remove invitation
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </Sample>
            <Sample name="DropdownMenu">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline">Person actions</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuItem onSelect={() => toast.info('Access details selected')}>
                            View access
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => toast.info('Person flagged for review')}>
                            Flag for review
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </Sample>
            <Sample name="Popover">
                <Popover>
                    <PopoverTrigger asChild>
                        <Button variant="outline">Activity filter</Button>
                    </PopoverTrigger>
                    <PopoverContent align="start">
                        <label className="gallery-flow">
                            <Checkbox /> Show recent changes
                        </label>
                    </PopoverContent>
                </Popover>
            </Sample>
            <Sample name="Sheet">
                <Sheet>
                    <SheetTrigger asChild>
                        <Button variant="outline">Person details</Button>
                    </SheetTrigger>
                    <SheetContent>
                        <SheetHeader>
                            <SheetTitle>Imani Brooks</SheetTitle>
                            <SheetDescription>Workspace administrator</SheetDescription>
                        </SheetHeader>
                        <div className="px-4">
                            <Badge variant="outline">Active</Badge>
                        </div>
                    </SheetContent>
                </Sheet>
            </Sample>
            <Sample name="Tooltip">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="outline">View explanation</Button>
                    </TooltipTrigger>
                    <TooltipContent>Invitations grant access once accepted.</TooltipContent>
                </Tooltip>
            </Sample>
        </>
    );
}

function Gallery() {
    const [palette, setPalette] = useState<ThemeId>(DEFAULT_THEME_ID);
    const [mode, setMode] = useState<ColorMode>('system');
    return (
        <ThemeProvider appearance={{ signedIn: true, themeId: palette, workspaceThemeId: palette, colorMode: mode }}>
            <TooltipProvider>
                <header className="gallery-header">
                    <div className="gallery-wrap gallery-toolbar">
                        <div className="gallery-brand">
                            <img width="32" height="32" src={logo} alt="" />
                            Socio
                        </div>
                        <div className="gallery-appearance">
                            <label htmlFor="gallery-palette">Theme</label>
                            <select
                                id="gallery-palette"
                                data-slot="native-select"
                                className={nativeSelect}
                                value={palette}
                                onChange={(event) => setPalette(event.currentTarget.value as ThemeId)}
                            >
                                {THEME_IDS.map((id) => (
                                    <option key={id} value={id}>
                                        {THEME_LABELS[id]}
                                    </option>
                                ))}
                            </select>
                            <label htmlFor="gallery-mode">Color mode</label>
                            <select
                                id="gallery-mode"
                                data-slot="native-select"
                                className={nativeSelect}
                                value={mode}
                                onChange={(event) => setMode(event.currentTarget.value as ColorMode)}
                            >
                                {COLOR_MODES.map((id) => (
                                    <option key={id} value={id}>
                                        {id[0]!.toUpperCase() + id.slice(1)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </header>
                <main data-slot="workspace-canvas">
                    <div className="gallery-wrap gallery-main">
                        <h1 className="sr-only">Component gallery</h1>
                        <PeopleDesk />
                        <h2 className="gallery-library-title">Component library</h2>
                        <div className="gallery-groups">
                            <section>
                                <h3>Controls</h3>
                                <Card className="gap-0 py-0">
                                    <Fields />
                                </Card>
                            </section>
                            <section>
                                <h3>Surfaces and status</h3>
                                <Card className="gap-0 py-0">
                                    <Displays />
                                </Card>
                            </section>
                            <section>
                                <h3>Navigation</h3>
                                <Card className="gap-0 py-0">
                                    <Navigation />
                                </Card>
                            </section>
                            <section>
                                <h3>Overlays</h3>
                                <Card className="gap-0 py-0">
                                    <Overlays />
                                </Card>
                            </section>
                        </div>
                    </div>
                </main>
                <Toaster />
            </TooltipProvider>
        </ThemeProvider>
    );
}

createRoot(document.getElementById('root')!).render(<Gallery />);
