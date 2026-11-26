import {
    ArrowUpRight,
    ChevronRight,
    Layers,
    LayoutPanelLeft,
    Search,
    Shield,
    UserRoundPlus,
    Users,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { Card } from '@/components/ui/card';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const members = [
    {
        name: 'Avery Chen',
        email: 'avery@example.test',
        initials: 'AC',
        role: 'Owner',
        status: 'Active',
        tone: 'warning',
        spaces: 4,
    },
    {
        name: 'Elena Morales',
        email: 'elena@example.test',
        initials: 'EM',
        role: 'Admin',
        status: 'Active',
        tone: 'rose',
        spaces: 4,
    },
    {
        name: 'Imani Brooks',
        email: 'imani@example.test',
        initials: 'IB',
        role: 'Member',
        status: 'Active',
        tone: 'info',
        spaces: 3,
    },
    {
        name: 'Sofia Rivera',
        email: 'sofia@example.test',
        initials: 'SR',
        role: 'Member',
        status: 'Invite expired',
        tone: 'warning',
        spaces: 0,
    },
    {
        name: 'Lucas Martin',
        email: 'lucas@example.test',
        initials: 'LM',
        role: 'Member',
        status: 'Invited',
        tone: 'rose',
        spaces: 0,
    },
] as const;

type Member = (typeof members)[number];

function Identity({ member }: { member: Member }) {
    return (
        <>
            <Avatar shape="rounded" className="desk-avatar" data-tone={member.tone} aria-hidden="true">
                <AvatarFallback>{member.initials}</AvatarFallback>
            </Avatar>
            <span className="desk-identity">
                <strong>{member.name}</strong>
                <small>{member.email}</small>
            </span>
        </>
    );
}

function Status({ member }: { member: Member }) {
    const variant = { Active: 'success', Invited: 'info', 'Invite expired': 'warning' } as const;
    return <Badge variant={variant[member.status]}>{member.status}</Badge>;
}

export function PeopleDesk() {
    const [member, setMember] = useState<Member>(members[2]);
    const [tab, setTab] = useState('people');
    const [filter, setFilter] = useState('');
    const [quickActions, setQuickActions] = useState(false);
    const filtered = members.filter(({ name, email }) =>
        `${name} ${email}`.toLowerCase().includes(filter.trim().toLowerCase()),
    );

    const showMember = (person: Member) => {
        setMember(person);
        setTab('people');
        setFilter('');
    };

    return (
        <section className="gallery-desk" aria-labelledby="desk-title">
            <header data-slot="app-header" className="desk-toolbar">
                <Breadcrumb>
                    <BreadcrumbList>
                        <BreadcrumbItem>Settings</BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbPage>People</BreadcrumbPage>
                    </BreadcrumbList>
                </Breadcrumb>
                <div className="gallery-flow">
                    <CommandDialog
                        open={quickActions}
                        onOpenChange={setQuickActions}
                        title="Quick actions"
                        description="Find a person or open groups."
                        trigger={
                            <Button variant="outline">
                                <Search aria-hidden="true" />
                                Quick actions
                            </Button>
                        }
                    >
                        <CommandInput
                            placeholder="Find a person or run an action…"
                            aria-label="Find a person or run an action"
                            className="pr-8"
                        />
                        <CommandList className="p-2">
                            <CommandEmpty>No matching actions or people</CommandEmpty>
                            <CommandGroup heading="Actions">
                                <CommandItem
                                    onSelect={() => {
                                        setTab('groups');
                                        setQuickActions(false);
                                    }}
                                >
                                    <Layers aria-hidden="true" /> Open groups
                                    <ArrowUpRight aria-hidden="true" className="ml-auto" />
                                </CommandItem>
                            </CommandGroup>
                            <CommandGroup heading="People">
                                {members.map((person) => (
                                    <CommandItem
                                        key={person.email}
                                        value={`${person.name} ${person.email}`}
                                        onSelect={() => {
                                            showMember(person);
                                            setQuickActions(false);
                                        }}
                                    >
                                        <Identity member={person} />
                                        <ChevronRight aria-hidden="true" className="ml-auto" />
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </CommandDialog>
                    <Sheet>
                        <SheetTrigger asChild>
                            <Button variant="outline">
                                <Shield aria-hidden="true" />
                                Access review
                            </Button>
                        </SheetTrigger>
                        <SheetContent>
                            <SheetHeader>
                                <SheetTitle>Access review</SheetTitle>
                                <SheetDescription>Check workspace roles and outstanding invitations.</SheetDescription>
                            </SheetHeader>
                            <div className="grid gap-2 px-4">
                                {members
                                    .filter((person) => person.status !== 'Active' || person.role === 'Admin')
                                    .map((person) => (
                                        <SheetClose key={person.email} asChild>
                                            <Button
                                                variant="outline"
                                                className="h-auto justify-start py-2"
                                                onClick={() => showMember(person)}
                                            >
                                                <Identity member={person} />
                                                <ChevronRight aria-hidden="true" className="ml-auto" />
                                            </Button>
                                        </SheetClose>
                                    ))}
                            </div>
                        </SheetContent>
                    </Sheet>
                </div>
            </header>
            <div className="desk-heading">
                <div>
                    <h2 id="desk-title">People Desk</h2>
                    <p>Manage members and access to your workspace.</p>
                </div>
                <Dialog>
                    <DialogTrigger asChild>
                        <Button>
                            <UserRoundPlus aria-hidden="true" />
                            Invite people
                        </Button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Invite people</DialogTitle>
                            <DialogDescription>Try inviting a person with sample data.</DialogDescription>
                        </DialogHeader>
                        <form
                            className="grid gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                toast.success('Sample invitation saved');
                            }}
                        >
                            <label htmlFor="desk-invite">Work email</label>
                            <Input id="desk-invite" type="email" required />
                            <DialogFooter>
                                <DialogClose asChild>
                                    <Button type="button" variant="outline">
                                        Close
                                    </Button>
                                </DialogClose>
                                <Button type="submit">Save invitation</Button>
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="gap-4">
                <TabsList aria-label="People Desk sections">
                    <TabsTrigger value="people">
                        <Users aria-hidden="true" /> People
                    </TabsTrigger>
                    <TabsTrigger value="groups">
                        <Layers aria-hidden="true" /> Groups
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="people">
                    <div className="desk-panels">
                        <Card className="gap-0 p-2">
                            <div className="desk-roster-header">
                                <h3>
                                    Members <small>{members.length} people</small>
                                </h3>
                                <div className="desk-search">
                                    <Search aria-hidden="true" />
                                    <Input
                                        type="search"
                                        aria-label="Filter members"
                                        placeholder="Filter members…"
                                        value={filter}
                                        onChange={(event) => setFilter(event.currentTarget.value)}
                                    />
                                </div>
                            </div>
                            <div className="desk-roster-labels" aria-hidden="true">
                                <span>Person</span>
                                <span>Role</span>
                                <span>Status</span>
                            </div>
                            <ul className="desk-roster">
                                {filtered.map((person) => (
                                    <li key={person.email}>
                                        <Button
                                            variant="ghost"
                                            className="desk-roster-row"
                                            aria-pressed={member === person}
                                            onClick={() => setMember(person)}
                                        >
                                            <span className="desk-row-person">
                                                <Identity member={person} />
                                            </span>
                                            <span className="desk-row-role">{person.role}</span>
                                            <Status member={person} />
                                            <ChevronRight aria-hidden="true" className="desk-row-arrow" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                            {filtered.length === 0 && (
                                <p role="status" className="px-2 py-5 text-muted-foreground">
                                    No matching members.
                                </p>
                            )}
                        </Card>
                        <Card className="gap-0 py-0">
                            <h3 className="desk-profile-title">
                                <LayoutPanelLeft aria-hidden="true" /> Member profile
                            </h3>
                            <div className="desk-profile">
                                <div className="desk-profile-identity">
                                    <Identity member={member} />
                                    <Status member={member} />
                                </div>
                                <dl>
                                    <div>
                                        <dt>Workspace role</dt>
                                        <dd>{member.role}</dd>
                                    </div>
                                    <div>
                                        <dt>Space access</dt>
                                        <dd>{member.spaces} spaces</dd>
                                    </div>
                                </dl>
                            </div>
                        </Card>
                    </div>
                </TabsContent>
                <TabsContent value="groups">
                    <Card className="gap-2 p-4">
                        <h3>Groups</h3>
                        <p className="text-muted-foreground">Workspace administrators · 2 people</p>
                    </Card>
                </TabsContent>
            </Tabs>
        </section>
    );
}
