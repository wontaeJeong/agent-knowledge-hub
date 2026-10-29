import path from 'node:path';
import { openStore } from './store.mjs';
import { hash, requireId, revision, serial, validatePage } from './protocol.mjs';

// SYNTHETIC development service only: no production SSO, SQL transactions or source authority.
export async function createService({ file, identities, pages = [] }) {
  const store = await openStore(path.resolve(`${file}.store`));
  let state;
  try {
    state = await store.read();
    if (!state) {
      state = { schema: 1, shared: pages.map(validatePage), personal: {}, mutations: {}, proposals: {} };
      await store.write(state);
    }
    if (state.schema !== 1 || !Array.isArray(state.shared) || !state.personal || !state.mutations || !state.proposals) throw Error('CORRUPT_STATE');
  } catch (e) { await store.close(); throw e; }
  const queue = serial();
  const visible = (actor, page) => page.localCopyAllowed === true && actor.spaces.includes(page.spaceId);
  const personalVisible = (actor, p) => !p.upstream || state.shared.some(s => s.id === p.upstream.pageId && s.spaceId === p.upstream.spaceId && visible(actor, s));
  return {
    request(token, action, input) { return queue(async () => {
      if (!Object.hasOwn(identities, token)) throw Error('UNAUTHORIZED');
      const actor = identities[token];
      requireId(actor.userId);
      const own = state.personal[actor.userId] ?? [];
      if (action === 'snapshot') return structuredClone({ shared: state.shared.filter(p => visible(actor, p)), personal: own.filter(p => personalVisible(actor, p)) });
      if (action === 'access') {
        const metadata = p => ({ id: p.id, spaceId: p.spaceId, version: p.version });
        return { shared: state.shared.filter(p => visible(actor, p)).map(metadata), personal: own.filter(p => personalVisible(actor, p)).map(metadata) };
      }
      const next = structuredClone(state);
      let result;
      if (action === 'push') {
        requireId(input.mutationId); revision(input.baseVersion);
        const p = validatePage(input.page);
        if (p.spaceId !== 'personal') throw Error('FORBIDDEN');
        const old = own.find(x => x.id === p.id);
        if (old && !personalVisible(actor, old)) throw Error('FORBIDDEN');
        const key = `${actor.userId}:${input.mutationId}`, fingerprint = hash(input);
        const previous = state.mutations[key];
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
          return structuredClone(previous.result);
        }
        if ((old?.version ?? 0) !== input.baseVersion) throw Error('STALE_VERSION');
        const inherited = old?.upstream;
        if (inherited && hash(inherited) !== hash(p.upstream)) throw Error('FORBIDDEN');
        let origin;
        if (p.upstream) {
          origin = state.shared.find(x => x.id === p.upstream.pageId && x.spaceId === p.upstream.spaceId && visible(actor, x));
          if (!origin) throw Error('FORBIDDEN');
          if (!old && origin.version !== p.upstream.version) throw Error('STALE_VERSION');
        }
        const required = old?.sourceRefs ?? origin?.sourceRefs ?? [];
        if (hash(p.sourceRefs) !== hash(required)) throw Error('EVIDENCE_UNAVAILABLE');
        result = { ...p, version: input.baseVersion + 1, ...(origin ? { upstream: inherited ?? { spaceId: origin.spaceId, pageId: origin.id, version: origin.version } } : {}) };
        next.personal[actor.userId] = [...own.filter(x => x.id !== p.id), result];
        next.mutations[key] = { fingerprint, result };
      } else if (action === 'propose') {
        requireId(input.id); requireId(input.pageId); requireId(input.targetSpaceId); revision(input.baseVersion);
        if (!actor.spaces.includes(input.targetSpaceId)) throw Error('FORBIDDEN');
        const p = own.find(x => x.id === input.pageId);
        if (!p || !personalVisible(actor, p)) throw Error('NOT_FOUND');
        if (p.upstream && p.upstream.spaceId !== input.targetSpaceId) throw Error('SOURCE_SCOPE_CONFLICT');
        const targetId = p.upstream?.pageId ?? p.id;
        const target = state.shared.find(x => x.id === targetId && x.spaceId === input.targetSpaceId);
        if ((target?.version ?? 0) !== input.baseVersion || (p.upstream && p.upstream.version !== input.baseVersion)) throw Error('STALE_VERSION');
        const proposal = { id: input.id, author: actor.userId, page: { ...p, id: targetId, spaceId: input.targetSpaceId }, baseVersion: input.baseVersion, status: 'pending' };
        const old = state.proposals[input.id];
        if (old) {
          if (old.author !== actor.userId || hash({ ...old, status: 'pending' }) !== hash(proposal)) throw Error('IDEMPOTENCY_CONFLICT');
          return structuredClone(old);
        }
        next.proposals[input.id] = proposal;
        result = proposal;
      } else if (action === 'approve' || action === 'publish') {
        requireId(input.id);
        const p = next.proposals[input.id];
        if (!actor.reviewer || !p || !actor.spaces.includes(p.page.spaceId)) throw Error('FORBIDDEN');
        // Author's current access is rechecked; a review does not grant source access.
        const author = Object.values(identities).find(x => x.userId === p.author);
        if (!author || !author.spaces.includes(p.page.spaceId)) throw Error('FORBIDDEN');
        if (action === 'publish' && p.status === 'published') return structuredClone(p);
        const target = state.shared.find(x => x.id === p.page.id && x.spaceId === p.page.spaceId);
        if ((target?.version ?? 0) !== p.baseVersion) throw Error('STALE_VERSION');
        if (p.page.upstream && (!target || !visible(actor, target) || !visible(author, target) || hash(target.sourceRefs) !== hash(p.page.sourceRefs))) throw Error('SOURCE_SCOPE_CONFLICT');
        if (action === 'approve') {
          if (p.status !== 'pending') throw Error('INVALID_STATE');
          p.status = 'approved'; p.approvedHash = hash(p.page);
        } else {
          if (p.status !== 'approved' || p.approvedHash !== hash(p.page)) throw Error('APPROVAL_STALE');
          const published = { ...p.page, version: p.baseVersion + 1 };
          delete published.upstream;
          next.shared = [...state.shared.filter(x => x.id !== published.id || x.spaceId !== published.spaceId), published];
          p.status = 'published';
        }
        result = p;
      } else throw Error('NOT_FOUND');
      await store.write(next);
      state = next;
      return structuredClone(result);
    }); },
    close() { return queue(() => store.close()); },
  };
}
