import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase, setDatabaseForTesting } from '../../src/db/index.js';
import { PickupRepository } from '../../src/db/repositories/pickups.js';
import { RosterSlotRepository } from '../../src/db/repositories/roster-slots.js';
import { PickupEventRepository } from '../../src/db/repositories/pickup-events.js';
import { SignupRepository } from '../../src/db/repositories/signups.js';
import { PickupSpaceRepository } from '../../src/db/repositories/pickup-spaces.js';
import { ROLES } from '../../src/domain/roles.js';
import { handleManageCommand, handleManageComponent, handleManageEntry, resetManageSessions } from '../../src/discord/flows/manage.js';
import { decodeId } from '../../src/discord/ids.js';
import { mockChatInputInteraction, mockComponentInteraction, mockGuild, mockMember, mockClient, mockMessage, mockTextChannel, mockPermissions } from '../helpers/discord-mocks.js';
import { reconciliationMarker } from '../../src/discord/render.js';
import { PickupNotificationRepository } from '../../src/db/repositories/pickup-notifications.js';
import { seedSpace, spaceSnapshot } from '../helpers/fixtures.js';

let db: Database.Database;
const guildId = 'guild';
const actorId = 'staff';
let staff: ReturnType<typeof mockMember>;
let guild: ReturnType<typeof mockGuild>;
let client: ReturnType<typeof mockClient>;
let privateMessage: ReturnType<typeof mockMessage>;

beforeEach(() => {
  db = openDatabase(':memory:'); setDatabaseForTesting(db); resetManageSessions();
  staff = mockMember({ id: actorId, roleIds: ['staff-role'] });
  guild = mockGuild({ id: guildId });
  const defaultFetch = guild.members.fetch.bind(guild.members);
  vi.spyOn(guild.members, 'fetch').mockImplementation(async (arg: any) => {
    if (arg?.user === actorId || arg === actorId) return staff;
    return defaultFetch(arg);
  });
  client = mockClient({ guilds: { [guildId]: guild } }); privateMessage = mockMessage({ id: 'private' });
});
afterEach(() => { resetManageSessions(); setDatabaseForTesting(null); db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function pickup(format: 'pickup_vs_pickup' | 'pickup_vs_premade' = 'pickup_vs_premade') {
  const space = seedSpace(db, { guildId, name: `Space ${Math.random()}`, authorizedRoleIds: ['staff-role'] });
  const created = new PickupRepository().create({ guildId, createdBy: actorId, format, startAt: Math.floor(Date.now()/1000)+3600, roleLimit: 2, ...spaceSnapshot(space) });
  const slots = (format === 'pickup_vs_pickup' ? ['order','chaos'] as const : ['pickup'] as const)
    .flatMap(team => ROLES.map(role => ({ team, role, userId: `${team}-${role}` })));
  for (const s of slots) new SignupRepository().add(created.id, s.userId, s.role, 2);
  new RosterSlotRepository().replaceAll(created.id, slots);
  new PickupRepository().transitionStatus(created.id, 'open', 'roster_ready');
  new PickupRepository().setMessageIds(created.id, { reviewMessageId: `staff-${created.id}` });
  return new PickupRepository().byId(created.id)!;
}
function payload(interaction: any) { return interaction.editReply.mock.calls.at(-1)?.[0] ?? interaction.reply.mock.calls.at(-1)?.[0]; }
function controls(output: any): any[] { return (output?.components ?? []).flatMap((r: any) => (r.toJSON?.() ?? r).components); }
function command() {
  const interaction = mockChatInputInteraction({ guildId, guild, member: staff, userId: actorId, client });
  vi.spyOn(interaction,'fetchReply').mockResolvedValue(privateMessage);
  return interaction;
}
async function click(customId: string, values?: string[], userId = actorId, message = privateMessage) {
  const interaction = mockComponentInteraction({ guildId, guild, member: staff, userId, client, message,
    customId, values, kind: values ? 'string-select' : 'button' });
  await handleManageComponent(interaction, decodeId(customId)!);
  return interaction;
}
async function open(p = pickup()) {
  const entry = command(); await handleManageCommand(entry);
  const select = controls(payload(entry)).find(c => c.type === 3);
  const chosen = await click(select.custom_id, [String(p.id)]);
  return { p, output: payload(chosen) };
}
async function swapPreview(p = pickup()) {
  const { output } = await open(p); const slots = new RosterSlotRepository().forPickup(p.id);
  const entry = await click(controls(output).find(c => c.label === (p.status === 'published' ? 'Swap' : 'Change Role')).custom_id);
  const first = await click(controls(payload(entry)).find(c=>c.type===3).custom_id,[String(slots[0]!.id)]);
  const proposed = await click(controls(payload(first)).find(c=>c.type===3).custom_id,[String(slots[1]!.id)]);
  return { p, slots, output:payload(proposed), confirmId:controls(payload(proposed)).find(c=>c.label==='Confirm').custom_id };
}

describe('private pickup management', () => {
  it('allows a current emergency substitute through the member selector without requiring a signup', async()=>{
    const p=pickup();new PickupRepository().transitionStatus(p.id,'roster_ready','published');
    const {output}=await open(new PickupRepository().byId(p.id)!);
    const entry=await click(controls(output).find(c=>c.label==='Replace').custom_id);
    const target=new RosterSlotRepository().forPickup(p.id)[0]!;
    const candidates=await click(controls(payload(entry)).find(c=>c.type===3).custom_id,[String(target.id)]);
    const customId=controls(payload(candidates)).find(c=>c.type===5).custom_id;
    const select=mockComponentInteraction({guildId,guild,member:staff,userId:actorId,client,message:privateMessage,customId,values:['emergency'],kind:'user-select'});
    await handleManageComponent(select,decodeId(customId)!);
    await click(controls(payload(select)).find(c=>c.label==='Confirm').custom_id);
    expect(new RosterSlotRepository().byId(target.id)).toMatchObject({userId:'emergency',staffAssigned:true});
    expect(new PickupNotificationRepository().forPickup(p.id).filter(n=>n.kind==='replacement_notice')).toHaveLength(1);
  });
  it('rechecks space authority after target verification before a mutation commits', async()=>{
    const {p,slots,confirmId}=await swapPreview();
    const original=vi.mocked(guild.members.fetch).getMockImplementation()!;
    vi.mocked(guild.members.fetch).mockImplementation(async(arg:any)=>{
      if(arg?.user===slots[0]!.userId) new PickupSpaceRepository().setField(p.pickupSpaceId!,'authorized_role_ids',['other']);
      return original(arg);
    });
    await click(confirmId);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(slots);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
  it('confirms a shuffle using the exact displayed assignments without regenerating', async()=>{
    const p=pickup('pickup_vs_pickup');const {output}=await open(p);
    const proposed=await click(controls(output).find(c=>c.label==='Shuffle').custom_id);
    const displayed=[...payload(proposed).content.matchAll(/<@([^>]+)>/g)].map(m=>m[1]);
    await click(controls(payload(proposed)).find(c=>c.label==='Confirm').custom_id);
    expect(new RosterSlotRepository().forPickup(p.id).map(s=>s.userId)).toEqual(displayed);
    expect(new PickupEventRepository().forPickup(p.id)).toHaveLength(1);
  });
  it('keeps large candidate lists paginated and all controls within Discord limits', async()=>{
    const p=pickup();new PickupRepository().transitionStatus(p.id,'roster_ready','published');
    for(let i=0;i<61;i++) {
      const userId=`bench-${i}`;new SignupRepository().add(p.id,userId,'solo',2);
      guild.members.cache.set(userId,mockMember({id:userId,displayName:'Same '+ 'long '.repeat(30)}));
    }
    const {output}=await open(new PickupRepository().byId(p.id)!);
    const entry=await click(controls(output).find(c=>c.label==='Replace').custom_id);
    const select=controls(payload(entry)).find(c=>c.type===3);
    const candidates=await click(select.custom_id,[String(new RosterSlotRepository().forPickup(p.id)[0]!.id)]);
    let page=payload(candidates);
    const seen:string[]=[];
    for(let i=0;i<3;i++) {
      expect(page.components.length).toBeLessThanOrEqual(5);
      const menu=controls(page).find(c=>c.type===3);
      expect(menu.options.length).toBeLessThanOrEqual(25);
      for(const c of controls(page)) if(c.custom_id)expect(c.custom_id.length).toBeLessThanOrEqual(100);
      for(const o of menu.options) {expect(o.label.length).toBeLessThanOrEqual(100);seen.push(o.value);}
      if(i<2) page=payload(await click(controls(page).find(c=>c.label==='Next').custom_id));
    }
    expect(new Set(seen).size).toBe(61);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
  it('cancels through a preview and terminal workspace retains only read-only navigation', async()=>{
    const {p,output}=await open();
    const proposed=await click(controls(output).find(c=>c.label==='Cancel').custom_id);
    expect(new PickupRepository().byId(p.id)?.status).toBe('roster_ready');
    const done=await click(controls(payload(proposed)).find(c=>c.label==='Confirm').custom_id);
    expect(new PickupRepository().byId(p.id)?.status).toBe('cancelled');
    const view=await click(controls(payload(done)).find(c=>c.label==='Refresh').custom_id);
    expect(controls(payload(view)).filter(c=>c.custom_id).map(c=>c.label)).toEqual(['Refresh','Back','Close']);
  });
  it('retains the original roster after second-space permission denial and retries publication once', async()=>{
    const p=pickup(); const before=new RosterSlotRepository().forPickup(p.id);
    const channel=mockTextChannel({id:p.rosterChannelId!,guildId,permissions:['ViewChannel','EmbedLinks']});
    client=mockClient({guilds:{[guildId]:guild},channels:{[p.rosterChannelId!]:channel}});
    let opened=await open(p);
    let proposed=await click(controls(opened.output).find(c=>c.label==='Publish').custom_id);
    await click(controls(payload(proposed)).find(c=>c.label==='Confirm').custom_id);
    expect(channel.send).not.toHaveBeenCalled();
    expect(new PickupRepository().byId(p.id)).toMatchObject({status:'roster_ready',publicationStatus:'failed'});
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(before);
    vi.spyOn(channel,'permissionsFor').mockReturnValue(mockPermissions(['ViewChannel','SendMessages','EmbedLinks','ReadMessageHistory']));
    new PickupSpaceRepository().setField(p.pickupSpaceId!,'roster_channel_id','different-destination');
    opened=await open(new PickupRepository().byId(p.id)!);
    proposed=await click(controls(opened.output).find(c=>c.label==='Retry Publication').custom_id);
    const confirmId=controls(payload(proposed)).find(c=>c.label==='Confirm').custom_id;
    await click(confirmId); await click(confirmId);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(new PickupRepository().byId(p.id)).toMatchObject({status:'published',publicationStatus:'confirmed',rosterChannelId:p.rosterChannelId});
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(before);
  });
  it('repairs an ambiguous publication by finding its existing marker after restart, without resending', async()=>{
    const p=pickup(); const channel=mockTextChannel({id:p.rosterChannelId!,guildId});
    channel.send.mockRejectedValueOnce(new Error('timeout'));
    client=mockClient({guilds:{[guildId]:guild},channels:{[p.rosterChannelId!]:channel}});
    const {output}=await open(p);
    const proposed=await click(controls(output).find(c=>c.label==='Publish').custom_id);
    await click(controls(payload(proposed)).find(c=>c.label==='Confirm').custom_id);
    expect(new PickupRepository().byId(p.id)?.publicationStatus).toBe('uncertain');
    resetManageSessions();
    const delivered=mockMessage({id:'existing-roster',content:reconciliationMarker('roster',p.id)});
    const restored=mockTextChannel({id:p.rosterChannelId!,guildId,messages:{[delivered.id]:delivered}});
    client=mockClient({guilds:{[guildId]:guild},channels:{[p.rosterChannelId!]:restored}});
    const recovered=await open(new PickupRepository().byId(p.id)!);
    expect(controls(recovered.output).some(c=>c.label==='Shuffle')).toBe(false);
    await click(controls(recovered.output).find(c=>c.label==='Repair Delivery').custom_id);
    expect(restored.send).not.toHaveBeenCalled();
    expect(new PickupRepository().byId(p.id)).toMatchObject({status:'published',rosterMessageId:delivered.id,publicationStatus:'confirmed'});
    expect(new PickupNotificationRepository().due(Date.now()+4_000_000).filter(n=>n.kind==='roster_reminder')).toHaveLength(1);
  });
  it('refuses a preview if assignments changed without a version update', async () => {
    const { p, slots, confirmId } = await swapPreview();
    new RosterSlotRepository().swapOccupants(slots[1]!.id, slots[2]!.id, true);
    const before = new RosterSlotRepository().forPickup(p.id);
    const refused = await click(confirmId);
    expect(payload(refused).content).toContain('changed');
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(before);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
  it.each(['permission','version','expiry','restart','owner','message'] as const)('refuses a confirmation after %s changes', async reason => {
    const {p, slots,confirmId}=await swapPreview();
    if(reason==='permission') new PickupSpaceRepository().setField(p.pickupSpaceId!,'authorized_role_ids',['other']);
    if(reason==='version') new PickupRepository().bumpVersion(p.id,p.version);
    if(reason==='expiry') {vi.useFakeTimers();vi.setSystemTime(Date.now()+11*60_000);}
    if(reason==='restart') resetManageSessions();
    await click(confirmId,undefined,reason==='owner'?'other':actorId,reason==='message'?mockMessage({id:'foreign'}):privateMessage);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(slots);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
  it('serializes double confirmation into one mutation', async()=>{
    const {p,confirmId}=await swapPreview();
    await Promise.all([click(confirmId),click(confirmId)]);
    expect(new PickupEventRepository().forPickup(p.id)).toHaveLength(1);
    expect(new PickupRepository().byId(p.id)?.version).toBe(p.version+1);
  });
  it('opens the workspace only from the current staff card and can reopen it after a restart', async () => {
    const p = pickup();
    const wrong = mockComponentInteraction({ guildId, guild, member: staff, userId: actorId, client, message: mockMessage({id:'old-card'}) });
    await handleManageEntry(wrong, { action:'manage', pickupId:p.id,args:[] });
    expect(wrong.reply).toHaveBeenCalledWith(expect.objectContaining({content:expect.stringContaining('current message')}));
    resetManageSessions();
    const current = mockComponentInteraction({ guildId, guild, member:staff,userId:actorId,client,message:mockMessage({id:p.reviewMessageId!}) });
    vi.spyOn(current,'fetchReply').mockResolvedValue(privateMessage);
    await handleManageEntry(current,{action:'manage',pickupId:p.id,args:[]});
    expect(controls(payload(current)).some(c=>c.label==='Shuffle')).toBe(true);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
  it.each(['pickup_vs_pickup', 'pickup_vs_premade'] as const)('publishes then finishes %s through confirmed private previews', async format => {
    const p = pickup(format);
    const channel = mockTextChannel({ id: p.rosterChannelId!, guildId });
    client = mockClient({ guilds: { [guildId]: guild }, channels: { [p.rosterChannelId!]: channel } });
    const { output } = await open(p);
    const preview = await click(controls(output).find(c => c.label === 'Publish').custom_id);
    expect(channel.send).not.toHaveBeenCalled();
    await click(controls(payload(preview)).find(c => c.label === 'Confirm').custom_id);
    expect(new PickupRepository().byId(p.id)?.status).toBe('published');
    expect(channel.send).toHaveBeenCalledTimes(1);
    const published = await open(new PickupRepository().byId(p.id)!);
    const finish = await click(controls(published.output).find(c => c.label === 'Finish').custom_id);
    expect(new PickupRepository().byId(p.id)?.status).toBe('published');
    await click(controls(payload(finish)).find(c => c.label === 'Confirm').custom_id);
    expect(new PickupRepository().byId(p.id)?.status).toBe('finished');
  });
  it('offers replacement on a healthy published roster and schedules its notice only after confirmation', async () => {
    const p = pickup(); new PickupRepository().transitionStatus(p.id, 'roster_ready', 'published');
    new SignupRepository().add(p.id, 'bench', 'solo', 2);
    const before = new RosterSlotRepository().forPickup(p.id);
    const { output } = await open(new PickupRepository().byId(p.id)!);
    const replace = await click(controls(output).find(c => c.label === 'Replace').custom_id);
    const select = controls(payload(replace)).find(c => c.type === 3);
    const candidates = await click(select.custom_id, [String(before[0]!.id)]);
    const bench = controls(payload(candidates)).find(c => c.type === 3);
    const proposed = await click(bench.custom_id, ['bench']);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(before);
    await click(controls(payload(proposed)).find(c => c.label === 'Confirm').custom_id);
    expect(new RosterSlotRepository().byId(before[0]!.id)?.userId).toBe('bench');
    expect(new PickupEventRepository().forPickup(p.id)[0]?.eventType).toBe('player_replaced');
  });
  it('previews a manual off-role seat and only writes after explicit confirmation', async () => {
    const p = pickup();
    new PickupRepository().transitionStatus(p.id, 'roster_ready', 'open');
    new RosterSlotRepository().replaceAll(p.id, []);
    const { output } = await open(new PickupRepository().byId(p.id)!);
    const seats = await click(controls(output).find(c => c.label === 'Seat Player').custom_id);
    const seatSelect = controls(payload(seats)).find(c => c.type === 3);
    const candidates = await click(seatSelect.custom_id, ['pickup:solo']);
    const candidateSelect = controls(payload(candidates)).find(c => c.type === 3);
    const selected = await click(candidateSelect.custom_id, ['pickup-mid']);
    expect(payload(selected).content).toContain('off-role');
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual([]);
    await click(controls(payload(selected)).find(c => c.label === 'Confirm').custom_id);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual([expect.objectContaining({ role: 'solo', userId: 'pickup-mid', staffAssigned: true })]);
  });
  it('previews an exact shuffle and Back discards it without any write', async () => {
    const { p, output } = await open(pickup('pickup_vs_pickup'));
    const before = new RosterSlotRepository().forPickup(p.id);
    const shuffled = await click(controls(output).find(c => c.label === 'Shuffle').custom_id);
    const previewOutput = payload(shuffled);
    expect(previewOutput.content).toContain('Confirm');
    const confirmId = controls(previewOutput).find(c => c.label === 'Confirm').custom_id;
    await click(controls(previewOutput).find(c => c.label === 'Back').custom_id);
    await click(confirmId);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(before);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
  it('previews a role swap without changing the roster, then commits that exact preview once', async () => {
    const { p, output } = await open();
    const before = new RosterSlotRepository().forPickup(p.id);
    const change = controls(output).find(c => c.label === 'Change Role');
    const source = await click(change.custom_id);
    const first = controls(payload(source)).find(c => c.type === 3);
    const target = await click(first.custom_id, [String(before[0]!.id)]);
    const second = controls(payload(target)).find(c => c.type === 3);
    const preview = await click(second.custom_id, [String(before[1]!.id)]);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(before);
    const confirm = controls(payload(preview)).find(c => c.label === 'Confirm');
    const done = await click(confirm.custom_id);
    expect(new RosterSlotRepository().byId(before[0]!.id)?.userId).toBe(before[1]!.userId);
    expect(new PickupEventRepository().forPickup(p.id)).toHaveLength(1);
    await click(confirm.custom_id);
    expect(new PickupEventRepository().forPickup(p.id)).toHaveLength(1);
    expect(payload(done).content).toContain('saved');
  });
  it('lists only authorized active pickups and opening/navigating changes no canonical state', async () => {
    const p = pickup(); const hidden = pickup();
    new PickupSpaceRepository().setField(hidden.pickupSpaceId!, 'authorized_role_ids', ['other-staff']);
    const before = new PickupRepository().byId(p.id); const slots = new RosterSlotRepository().forPickup(p.id);
    const entry = command(); await handleManageCommand(entry);
    const select = controls(payload(entry)).find(c => c.type === 3);
    expect(select.options.map((o: any) => o.value)).toEqual([String(p.id)]);
    const selected = await click(select.custom_id, [String(p.id)]);
    const refresh = controls(payload(selected)).find(c => c.label === 'Refresh');
    await click(refresh.custom_id);
    expect(new PickupRepository().byId(p.id)).toEqual(before);
    expect(new RosterSlotRepository().forPickup(p.id)).toEqual(slots);
    expect(new PickupEventRepository().forPickup(p.id)).toEqual([]);
  });
});
