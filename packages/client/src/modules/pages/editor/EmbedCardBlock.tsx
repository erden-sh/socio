import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { ExternalLink, FileText, Image as ImageIcon, Link2, MessageSquareQuote, Play } from 'lucide-react';
import { useState } from 'react';

import { embedCard, embedMediaUrl, type EmbedCard, type EmbedKind, type EmbedMedia } from '@socio/shared/embed-card';
import { dateTimeFormat } from '@socio/shared/locale';

import { LocalTime } from '../../../lib/local-time';

import './embed-card.css';

const KIND_ICON: Record<EmbedKind, typeof Link2> = {
    post: MessageSquareQuote,
    video: Play,
    photo: ImageIcon,
    article: FileText,
    link: Link2,
};
const published = dateTimeFormat({ dateStyle: 'medium' });

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
};

/**
 * One of the card's images: the copy in its person's Files, served by this
 * app. When it can't be shown (the file was deleted), a note takes its
 * place, so the card still reads.
 */
function CardImage({ card, media }: { card: EmbedCard; media: EmbedMedia }) {
    const [failed, setFailed] = useState(!media.id);
    const playable = media.kind !== 'image';
    if (failed) {
        return (
            <div className="embed-card-missing">
                {playable ? 'Video' : 'Image'} not available here
                {media.alt ? `: ${media.alt}` : ''}
            </div>
        );
    }
    const image = (
        <img
            src={embedMediaUrl(media.id!)}
            alt={media.alt ?? ''}
            loading="lazy"
            decoding="async"
            width={media.width}
            height={media.height}
            onError={() => setFailed(true)}
        />
    );
    if (!playable) {
        return image;
    }
    // A video plays on its own site: the card holds only its poster.
    return (
        <a
            className="embed-card-play"
            href={card.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Play on ${card.provider ?? hostOf(card.url)} (opens in a new tab)`}
        >
            {image}
            <span aria-hidden="true">
                <Play size={22} fill="currentColor" />
            </span>
        </a>
    );
}

/**
 * The link card in the page editor (CB-230): a static snapshot, read-only.
 * Its text was copied when it was made and its images are this app's
 * copies, so nothing on it loads from the linked site; its links open
 * there in a new tab. A card that doesn't parse shows a note instead.
 */
export function EmbedCardBlock({ node, selected }: ReactNodeViewProps) {
    const card = embedCard(node.attrs.card);
    if (!card) {
        return (
            <NodeViewWrapper className={`embed-card${selected ? ' selected' : ''}`} contentEditable={false}>
                <div className="embed-card-missing">This link card can’t be shown.</div>
            </NodeViewWrapper>
        );
    }
    const Icon = KIND_ICON[card.kind];
    const site = card.provider ?? hostOf(card.url);
    const time = card.publishedAt ? Date.parse(card.publishedAt) : NaN;
    return (
        <NodeViewWrapper
            as="figure"
            className={`embed-card${selected ? ' selected' : ''}`}
            data-kind={card.kind}
            contentEditable={false}
            aria-label={`${site} card${card.title ? `: ${card.title}` : ''}`}
        >
            <div className="embed-card-header">
                <span className="embed-card-icon" aria-hidden="true">
                    <Icon size={16} />
                </span>
                <span className="embed-card-byline">
                    {card.author ? (
                        <>
                            {card.authorUrl ? (
                                <a href={card.authorUrl} target="_blank" rel="noopener noreferrer nofollow">
                                    <strong>{card.author}</strong>
                                </a>
                            ) : (
                                <strong>{card.author}</strong>
                            )}
                            {card.handle && <span> {card.handle}</span>}
                            <span> · {site}</span>
                        </>
                    ) : (
                        <strong>{site}</strong>
                    )}
                </span>
            </div>
            {card.title && <p className="embed-card-title">{card.title}</p>}
            {card.text && <p className="embed-card-text">{card.text}</p>}
            {!!card.media?.length && (
                <div className="embed-card-media" data-count={Math.min(card.media.length, 4)}>
                    {card.media.map((media, index) => (
                        <CardImage key={media.id ?? index} card={card} media={media} />
                    ))}
                </div>
            )}
            <figcaption className="embed-card-footer">
                {Number.isFinite(time) && <LocalTime value={time} format={(value) => published.format(value)} />}
                <a href={card.url} target="_blank" rel="noopener noreferrer nofollow">
                    Open on {hostOf(card.url)}
                    <ExternalLink size={12} aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                </a>
            </figcaption>
        </NodeViewWrapper>
    );
}
