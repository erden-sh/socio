import { createContext, useContext } from 'react';

import type { SignInMethods } from '@socio/shared/auth';
import { isAdmin, isOperator } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

/** The signed-in user. Management controls hide for members; the server enforces it. */
export const CurrentUser = createContext<User | undefined>(undefined);
/** Admins. */
export const useIsAdmin = () => isAdmin(useContext(CurrentUser));
/**
 * The former operator check, now the admin check (CB-390): kept as
 * an alias until the Platform page moves to admins.
 */
export const useIsOperator = () => isOperator(useContext(CurrentUser));
/**
 * The sign-in methods with real accounts (Better Auth); undefined with
 * mock auth, where there is no account to manage.
 */
export const SignInSetup = createContext<SignInMethods | undefined>(undefined);
