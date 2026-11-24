import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
import { ComputerScreen } from '../src/modules/computers/ComputerScreen';

// How a computer step ended (a nonzero exit, a stop) is the trace's now
// (CB-72): packages/client/tests/turn-trace-ui.test.tsx.
it('labels the live view as current, with no image before the first screenshot', () => {
    const html = renderToStaticMarkup(<ComputerScreen dotId="scout" dotName="Scout" onExpand={() => {}} />);
    expect(html).toContain('Current browser view');
    expect(html).toContain('Connecting to computer…');
    expect(html).toContain('aria-label="Expand Scout computer"');
    expect(html).not.toContain('<img');
});
