const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

// Reduced fixtures from Twitch's expanded/collapsed sidebar DOM, inspected 2026-10-20.
function card(login, { kind = 'recommended', category = 'Just Chatting', name = login,
	collapsed = false, collaboration = false, legacy = false, wrapped = true, identity = true } = {}) {
	const attributes = identity && !collapsed ? `data-a-id="${kind}-channel-0" data-test-selector="${kind}-channel"` : '';
	const metadata = collapsed
		? `<div class="tw-avatar"><img class="tw-image-avatar" alt="${collaboration ? name + ' and Guest' : ''}"></div>
			${collaboration ? '<div class="tw-avatar"><img class="tw-image-avatar" alt="Guest"></div>' : ''}`
		: `<div data-a-target="side-nav-card-metadata">
			${collaboration ? `<div><p title="${name}">${name}</p><p title="${name}"> +2</p></div>`
			: `<div class="side-nav-card__title"><p data-a-target="side-nav-title" title="${name}">${name}</p></div>`}
			<div class="side-nav-card__metadata"><p ${legacy ? 'data-a-target="side-nav-game-title"' : ''} title="${category}">${category}</p></div>
		</div>`;
	const link = `<div class="side-nav-card"><a href="/${login}" class="${collapsed ? 'side-nav-card' : 'side-nav-card__link'}" ${attributes}>${metadata}</a></div>`;
	return wrapped ? `<div class="tw-transition"><div>${link}</div></div>` : link;
}
function section(contents, label = 'Live Channels') {
	return `<div class="side-nav-section" aria-label="${label}"><h3>${label}</h3><div class="tw-transition-group">${contents}</div></div>`;
}
function sidebar(contents, { idOnly = false } = {}) {
	return `<div ${idOnly ? '' : 'data-a-target="side-nav-bar"'}><nav id="side-nav">${contents}</nav></div>`;
}

async function setup(t, contents = '', { blacklist = {}, hideFollowing = true } = {}) {
	const dom = new JSDOM(`<div id="root">${contents}<main></main></div>`, {
		url: 'https://www.twitch.tv/example_channel', runScripts: 'outside-only'
	});
	t.after(() => dom.window.close());
	// Let jsdom's initial DOMContentLoaded fire before loading the extension scripts.
	await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
	const { window } = dom;
	window.chrome = {
		runtime: { onMessage: { addListener() {} } },
		storage: { local: { get: async () => ({ hideFollowing }) } }
	};
	const context = dom.getInternalVMContext();
	for (const file of ['common.js', 'directory.js']) {
		const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
		vm.runInContext(file === 'common.js' ? source.replace('const debug = 3;', 'const debug = 5;') : source, context);
	}
	const run = source => vm.runInContext(source, context);
	window.getBlacklistedItems = async () => JSON.parse(JSON.stringify(blacklist));
	await window.initExtensionState();
	await window.init();
	return { window, document: window.document, run };
}

function link(env, login) {
	return env.document.querySelector(`a[href="/${login}"]`);
}
function hidden(node) {
	return node.hasAttribute('data-uttv-hidden') && !!node.closest('[style*="display: none"]');
}
async function waitFor(predicate) {
	const deadline = Date.now() + 2500;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'sidebar update was not filtered in time');
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

test('current category metadata filters only the matching recommendation', async t => {
	const env = await setup(t, sidebar(section(card('blocked') + card('allowed', { category: 'Chess' }))), {
		blacklist: { categories: { 'just chatting': 1 } }
	});
	assert.equal(env.window.readSidebarItem(link(env, 'blocked')).category, 'Just Chatting');
	assert.ok(hidden(link(env, 'blocked')));
	assert.ok(!hidden(link(env, 'allowed')));
	assert.notEqual(env.document.querySelector('.side-nav-section').style.display, 'none');
});

test('legacy sidebar categories and display names remain supported', async t => {
	const env = await setup(t, sidebar(section(card('legacy', { legacy: true }))), {
		blacklist: { categories: { 'just chatting': 1 } }
	});
	assert.ok(hidden(link(env, 'legacy')));
});

test('expanded cards match both the display name and the channel login', async t => {
	const env = await setup(t, sidebar(section(card('first', { name: '表示名' }) + card('second', { name: 'Another Name' }))), {
		blacklist: { channels: { '表示名': 1, second: 1 } }
	});
	assert.ok(hidden(link(env, 'first')));
	assert.ok(hidden(link(env, 'second')));
});

test('collapsed cards with empty avatars or collaboration labels match the URL login', async t => {
	const env = await setup(t, sidebar(section(card('solo', { collapsed: true }) + card('host', { collapsed: true, collaboration: true }))), {
		blacklist: { channels: { solo: 1, host: 1 } }
	});
	assert.ok(hidden(link(env, 'solo')));
	assert.ok(hidden(link(env, 'host')));
});

test('expanded collaborations read the host name without the guest count', async t => {
	const env = await setup(t, sidebar(section(card('host', { name: 'HostDisplay', collaboration: true }))), {
		blacklist: { channels: { hostdisplay: 1 } }
	});
	assert.ok(hidden(link(env, 'host')));
});

test('collapsed cards preserve matching by a localized avatar display name', async t => {
	const env = await setup(t, sidebar(section(card('localized', { collapsed: true }))), {
		blacklist: { channels: { '表示名': 1 } }
	});
	link(env, 'localized').querySelector('img').alt = '表示名';
	await waitFor(() => hidden(link(env, 'localized')));
});

test('category filtering survives collapsing and expanding the same card', async t => {
	const env = await setup(t, sidebar(section(card('blocked'))), {
		blacklist: { categories: { 'just chatting': 1 } }
	});
	const container = link(env, 'blocked').closest('.tw-transition');
	container.innerHTML = card('blocked', { collapsed: true, wrapped: false });
	await waitFor(() => link(env, 'blocked').hasAttribute('data-uttv-processed'));
	assert.ok(hidden(link(env, 'blocked')));
	container.innerHTML = card('blocked', { category: 'Chess', wrapped: false });
	await waitFor(() => container.style.display !== 'none');
	assert.ok(!hidden(link(env, 'blocked')));
});

test('a reused collapsed card does not inherit a different channel\'s category', async t => {
	const env = await setup(t, sidebar(section(card('blocked'))), {
		blacklist: { categories: { 'just chatting': 1 } }
	});
	const container = link(env, 'blocked').closest('.tw-transition');
	container.innerHTML = card('other', { collapsed: true, wrapped: false });
	await waitFor(() => container.style.display !== 'none');
	assert.equal(env.window.readSidebarItem(link(env, 'other')).category, '');
});

test('channel pages filter an already loaded sidebar during initialization', async t => {
	const env = await setup(t, sidebar(section(card('blocked'))), { blacklist: { channels: { blocked: 1 } } });
	assert.ok(hidden(link(env, 'blocked')));
});

test('late sidebar mounting is detected even on a channel page', async t => {
	const env = await setup(t, '', { blacklist: { channels: { blocked: 1 } } });
	env.document.querySelector('#root').insertAdjacentHTML('afterbegin', sidebar(section(card('blocked'))));
	await waitFor(() => hidden(link(env, 'blocked')));
});

test('sidebar replacement reconnects the observer without waiting for navigation', async t => {
	const env = await setup(t, sidebar(section(card('allowed'))), { blacklist: { channels: { blocked: 1, later: 1 } } });
	const previous = env.document.querySelector('[data-a-target="side-nav-bar"]');
	previous.outerHTML = sidebar(section(card('blocked')));
	await waitFor(() => hidden(link(env, 'blocked')));
	env.document.querySelector('.tw-transition-group').insertAdjacentHTML('beforeend', card('later'));
	await waitFor(() => hidden(link(env, 'later')));
	assert.notEqual(previous.querySelector('a').style.display, 'none');
});

test('updates arriving inside the old cooldown are eventually filtered', async t => {
	const env = await setup(t, sidebar(section(card('allowed'))), { blacklist: { channels: { first: 1, second: 1 } } });
	const group = env.document.querySelector('.tw-transition-group');
	group.insertAdjacentHTML('beforeend', card('first'));
	await waitFor(() => hidden(link(env, 'first')));
	group.insertAdjacentHTML('beforeend', card('second'));
	await waitFor(() => hidden(link(env, 'second')));
});

test('metadata updates hide a reused card and restore it when the category becomes allowed', async t => {
	const env = await setup(t, sidebar(section(card('changing', { category: 'Chess' }))), {
		blacklist: { categories: { 'just chatting': 1 } }
	});
	const node = link(env, 'changing');
	const category = node.querySelector('.side-nav-card__metadata p');
	category.setAttribute('title', 'Just Chatting');
	category.textContent = 'Just Chatting';
	await waitFor(() => hidden(node));
	category.setAttribute('title', 'Chess');
	category.textContent = 'Chess';
	await waitFor(() => !node.hasAttribute('data-uttv-hidden'));
	assert.notEqual(node.closest('.tw-transition').style.display, 'none');
});

test('removing a blacklist entry restores the sidebar card and its original display style', async t => {
	const env = await setup(t, sidebar(section(card('blocked'))));
	const node = link(env, 'blocked');
	const container = node.closest('.tw-transition');
	container.style.setProperty('display', 'flex', 'important');
	env.run("modifyBlacklistedItems({ channels: { blocked: 1 }, categories: {}, tags: {}, titles: {} }); filterSidebar();");
	assert.ok(hidden(node));
	env.run("modifyBlacklistedItems({ channels: {}, categories: {}, tags: {}, titles: {} }); filterSidebar();");
	assert.equal(container.style.display, 'flex');
	assert.equal(container.style.getPropertyPriority('display'), 'important');
	assert.ok(!node.hasAttribute('data-uttv-hidden'));
});

test('recommendation-only filtering protects followed channels in every selector variant', async t => {
	const env = await setup(t, sidebar(
		section(card('followed', { kind: 'followed' }), 'Canales seguidos') +
		section(card('recommended'), 'Canales recomendados') +
		section(card('similar', { kind: 'similarity' }) + card('popular', { kind: 'popular' }), 'Otros canales')
	), { hideFollowing: false, blacklist: { channels: { '~': 1 } } });
	assert.ok(!hidden(link(env, 'followed')));
	for (const name of ['recommended', 'similar', 'popular']) assert.ok(hidden(link(env, name)));
});

test('collapsed sections preserve the followed-channel exemption', async t => {
	const env = await setup(t, sidebar(section(card('followed', { collapsed: true })) + section(card('recommended', { collapsed: true }))), {
		hideFollowing: false, blacklist: { channels: { followed: 1, recommended: 1 } }
	});
	assert.ok(!hidden(link(env, 'followed')));
	assert.ok(hidden(link(env, 'recommended')));
});

test('a single unidentified section is protected when followed filtering is disabled', async t => {
	const env = await setup(t, sidebar(section(card('followed', { collapsed: true }))), {
		hideFollowing: false, blacklist: { channels: { followed: 1 } }
	});
	assert.ok(!hidden(link(env, 'followed')));
});

test('known recommendation identity survives collapsing a single section', async t => {
	const env = await setup(t, sidebar(section(card('blocked'))), {
		hideFollowing: false, blacklist: { channels: { blocked: 1 } }
	});
	env.document.querySelector('.tw-transition-group').innerHTML = card('blocked', { collapsed: true });
	await waitFor(() => hidden(link(env, 'blocked')));
});

test('shorter card wrappers never hide the entire sidebar or adjacent channels', async t => {
	const env = await setup(t, sidebar(section(card('blocked', { wrapped: false }) + card('allowed', { wrapped: false })), { idOnly: true }), {
		blacklist: { channels: { blocked: 1 } }
	});
	assert.ok(hidden(link(env, 'blocked')));
	for (let node = link(env, 'allowed'); node; node = node.parentElement) {
		assert.notEqual(node.style.display, 'none');
	}
});

test('cards without analytics IDs are still discovered through the current link class', async t => {
	const env = await setup(t, sidebar(section(card('blocked', { identity: false }))), {
		blacklist: { channels: { blocked: 1 } }
	});
	assert.ok(hidden(link(env, 'blocked')));
});

test('a shared transition/card wrapper cannot hide another sidebar entry', async t => {
	const env = await setup(t, sidebar(section(`<div class="tw-transition side-nav-card">
		<a class="side-nav-card__link" href="/blocked"><p data-a-target="side-nav-title">blocked</p></a>
		<a class="side-nav-card__link" href="/allowed"><p data-a-target="side-nav-title">allowed</p></a>
	</div>`)), { blacklist: { channels: { blocked: 1 } } });
	assert.ok(hidden(link(env, 'blocked')));
	assert.notEqual(link(env, 'allowed').parentElement.style.display, 'none');
});

test('repeated setup retains a single observer and filtering does not trigger itself', async t => {
	const env = await setup(t, sidebar(section(card('allowed'))), { blacklist: { channels: { blocked: 1 } } });
	let calls = 0;
	const original = env.window.filterSidebar;
	env.window.filterSidebar = (...args) => { calls++; return original(...args); };
	for (let i = 0; i < 5; i++) env.window.observeSidebar();
	env.document.querySelector('.tw-transition-group').insertAdjacentHTML('beforeend', card('blocked'));
	await waitFor(() => hidden(link(env, 'blocked')));
	await new Promise(resolve => setTimeout(resolve, 250));
	assert.equal(calls, 1);
});
