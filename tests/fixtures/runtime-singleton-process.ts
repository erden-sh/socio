import { openDatabase } from '@socio/data/open';
import { RuntimeSession, type WorkLease } from '@socio/data/runtime-ownership';

const db = openDatabase(process.argv[2]);
db.exec('CREATE TABLE IF NOT EXISTS singleton_effects(owner TEXT, epoch INTEGER)');
const session = new RuntimeSession({ leaseMs: 1500, heartbeatMs: 200 });
const owner = session.attach(db);
const leases = new Map<string, WorkLease>();
process.on('message', async (message: { id: number; action: string; name?: string }) => {
    const name = message.name ?? 'scheduler';
    try {
        let result: unknown;
        if (message.action === 'claim') {
            result = owner.claimSingleton(name);
            if (result) {
                leases.set(name, result as WorkLease);
            }
        } else if (message.action === 'write') {
            const lease = leases.get(name);
            result = lease
                ? owner.guarded(lease, () => {
                      db.prepare('INSERT INTO singleton_effects VALUES(?,?)').run(session.id, lease.epoch);
                      return true;
                  })
                : { owned: false };
        } else if (message.action === 'release') {
            result = owner.release(leases.get(name)!);
        } else if (message.action === 'heartbeat') {
            await owner.heartbeat();
            result = true;
        } else if (message.action === 'snapshot') {
            result = {
                lease: db.prepare('SELECT * FROM runtime_leases WHERE resource=?').get(`singleton:${name}`),
                effects: db.prepare('SELECT * FROM singleton_effects').all(),
                work: db.prepare('SELECT COUNT(*) n FROM runtime_work').get()?.n,
            };
        } else {
            throw new Error('Unknown singleton fixture action.');
        }
        process.send?.({ id: message.id, result });
    } catch (error) {
        process.send?.({ id: message.id, error: String(error) });
    }
});
process.send?.({ ready: true });
