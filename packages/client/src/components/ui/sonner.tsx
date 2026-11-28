'use client';

import type { ToasterProps } from 'sonner';

import { Toaster as LibraryToaster } from '@socio/ui/components/sonner';

import { useThemeChoice } from '@/shell/theme';

export function Toaster(props: ToasterProps) {
    const { choice } = useThemeChoice();
    return <LibraryToaster theme={choice} {...props} />;
}
