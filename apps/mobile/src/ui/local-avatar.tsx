import { Image } from 'react-native';

import type { LocalId } from '@socio/shared/mascot';

import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';

import { socioPicture } from './local-art';
import { Squircle } from './squircle';
import { Text } from './text';

// A socio's avatar (the web's Mascot, still): its Local standing on the surface
// it's shown on, with no tile, as the web's RigAvatar shows it in the app; or
// its initial on a squircle for a Local with no picture. Hidden from screen
// readers: the row around it names the socio.

export interface LocalAvatarProps {
    readonly character: LocalId;
    readonly size: number;
    readonly testID?: string;
}

export function LocalAvatar({ character, size, testID }: LocalAvatarProps) {
    const picture = socioPicture(character);
    const muted = colorsOf(useScheme()).muted;
    if (picture.kind === 'art') {
        return (
            <Image
                testID={testID}
                source={picture.source}
                resizeMode="contain"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ width: size, height: size }}
            />
        );
    }
    return (
        <Squircle size={size} color={muted} testID={testID}>
            <Text variant={size < 32 ? 'caption1' : 'subheadline'} weight="medium" tone="muted">
                {picture.initial}
            </Text>
        </Squircle>
    );
}
