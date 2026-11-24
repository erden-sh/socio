// The ES module entry of the do-nothing @segment/analytics-node (see index.cjs).
import stub from './index.cjs';

export const { Analytics, isNoop } = stub;
export default Analytics;
