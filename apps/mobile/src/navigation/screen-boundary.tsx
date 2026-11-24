import { StackActions } from '@react-navigation/native';
import { Component, type ReactNode } from 'react';

import { Button, Screen, Text } from '../ui';

import { useRootGate } from './root-gate';
import { wayOut } from './routes';

// An error boundary around every screen of the root stack, with a way out:
// a screen that throws while rendering
// shows Try again and, where there is one, the way back, instead of taking the
// app down. The root stack sets it as its screenLayout (root-stack.tsx).

/** The slice of a screen's navigation the boundary uses. */
interface BoundaryNavigation {
    canGoBack(): boolean;
    goBack(): void;
    dispatch(action: ReturnType<typeof StackActions.replace>): void;
}

export interface ScreenBoundaryProps {
    readonly route: { readonly name: string; readonly params?: object };
    readonly navigation: BoundaryNavigation;
    readonly children: ReactNode;
}

interface BoundaryState {
    readonly failed: boolean;
    readonly params: object | undefined;
}

/** Catches a screen's render errors. New params (the same screen opened for something else) start it over. */
export class ScreenBoundary extends Component<ScreenBoundaryProps, BoundaryState> {
    override state: BoundaryState = { failed: false, params: this.props.route.params };

    static getDerivedStateFromProps(props: ScreenBoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
        return Object.is(props.route.params, state.params) ? null : { failed: false, params: props.route.params };
    }

    static getDerivedStateFromError(): Partial<BoundaryState> {
        return { failed: true };
    }

    private readonly retry = () => {
        this.setState({ failed: false });
    };

    override render() {
        if (!this.state.failed) {
            return this.props.children;
        }
        return <ScreenError route={this.props.route.name} navigation={this.props.navigation} retry={this.retry} />;
    }
}

function ScreenError(props: { route: string; navigation: BoundaryNavigation; retry: () => void }) {
    const exit = wayOut(props.route, props.navigation.canGoBack(), useRootGate());
    return (
        <Screen testID="screen-error" centered>
            <Text accessibilityRole="header" variant="title3" weight="semibold" className="text-center">
                This screen couldn't be shown
            </Text>
            <Text variant="subheadline" tone="muted" className="text-center">
                Try again. If it keeps happening, restart Socio.
            </Text>
            <Button label="Try again" icon="rotate-ccw" testID="screen-error-retry" onPress={props.retry} />
            {exit === null ? null : (
                <Button
                    label="Go back"
                    variant="ghost"
                    icon="arrow-left"
                    testID="screen-error-back"
                    onPress={() =>
                        exit === 'back'
                            ? props.navigation.goBack()
                            : props.navigation.dispatch(StackActions.replace(exit))
                    }
                />
            )}
        </Screen>
    );
}
