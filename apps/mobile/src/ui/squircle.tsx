import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import Svg, { ClipPath, Defs, Image as SvgImage, Path } from 'react-native-svg';

import { squirclePath } from './squircle-path';

// A squircle: a superellipse, |x|^n + |y|^n = 1, not a rectangle with rounded
// corners. The curve changes smoothly all the way round, with no point where a
// straight side meets an arc. That is the shape of iOS's app icons, and the one
// the owner asked for behind avatar fallbacks (2026-11-08). React Native can't
// clip to a path, so the shape is drawn as an SVG behind the children. Hidden
// from screen readers: whatever the squircle holds is named by the row around it.

export interface SquircleProps {
    readonly size: number;
    readonly color: string;
    readonly children?: ReactNode;
    readonly testID?: string;
}

export function Squircle({ size, color, children, testID }: SquircleProps) {
    return (
        <View
            testID={testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="items-center justify-center"
            style={{ width: size, height: size }}
        >
            <Svg width={size} height={size} style={{ position: 'absolute' }}>
                <Path d={squirclePath(size)} fill={color} />
            </Svg>
            {children}
        </View>
    );
}

export interface SquircleImageProps {
    readonly size: number;
    readonly source: ImageSourcePropType;
    /** A ring drawn 2 pt outside the image (the open workspace), in this color. */
    readonly ring?: string | null;
    readonly testID?: string;
}

/**
 * An image cut to a squircle: React Native's views can only round their
 * corners, so the image is drawn in the SVG, clipped by the same path. With a
 * ring, the whole is 8 pt larger: a 2 pt gap, then a 2 pt line.
 */
export function SquircleImage({ size, source, ring = null, testID }: SquircleImageProps) {
    const outer = ring === null ? size : size + 8;
    const inset = (outer - size) / 2;
    const clipId = `squircle-${size}`;
    return (
        <View
            testID={testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: outer, height: outer }}
        >
            <Svg width={outer} height={outer}>
                <Defs>
                    <ClipPath id={clipId}>
                        <Path d={squirclePath(size)} transform={`translate(${inset} ${inset})`} />
                    </ClipPath>
                </Defs>
                <SvgImage
                    href={source}
                    x={inset}
                    y={inset}
                    width={size}
                    height={size}
                    preserveAspectRatio="xMidYMid slice"
                    clipPath={`url(#${clipId})`}
                />
                {ring === null ? null : (
                    <Path
                        d={squirclePath(outer - 2)}
                        transform="translate(1 1)"
                        fill="none"
                        stroke={ring}
                        strokeWidth={2}
                    />
                )}
            </Svg>
        </View>
    );
}
