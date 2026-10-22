/** Message-level constraints builders do not check across separate components. */
export function validateDiscordPayload(payload: any): void {
  if (!payload || typeof payload !== 'object') return;
  const rows = (payload.components ?? []).map((row: any) => row.toJSON?.() ?? row);
  if (rows.length > 5) throw new Error('Discord payload exceeds five action rows');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.components?.length || row.components.length > 5) throw new Error('Invalid Discord action row');
    if (row.components.some((c: any) => c.type !== 2) && row.components.length !== 1) {
      throw new Error('Discord select menus require their own row');
    }
    for (const component of row.components) {
      if (component.custom_id !== undefined) {
        if (!component.custom_id.length || component.custom_id.length > 100) throw new Error('Invalid Discord custom_id length');
        if (ids.has(component.custom_id)) throw new Error('COMPONENT_CUSTOM_ID_DUPLICATED');
        ids.add(component.custom_id);
      }
      if (component.type === 3) {
        if (!component.options?.length || component.options.length > 25) throw new Error('Invalid Discord select options');
        for (const option of component.options) {
          if (!option.label?.length || option.label.length > 100 || !option.value?.length || option.value.length > 100
            || (option.description?.length ?? 0) > 100) throw new Error('Invalid Discord select option length');
        }
      }
    }
  }
  if ((payload.content?.length ?? 0) > 2_000) throw new Error('Discord content exceeds 2000 characters');
  const embeds = (payload.embeds ?? []).map((embed: any) => embed.toJSON?.() ?? embed);
  if (embeds.length > 10) throw new Error('Discord payload exceeds ten embeds');
  let length = 0;
  for (const embed of embeds) {
    if ((embed.title?.length ?? 0) > 256 || (embed.description?.length ?? 0) > 4_096
      || (embed.fields?.length ?? 0) > 25 || (embed.footer?.text?.length ?? 0) > 2_048
      || (embed.author?.name?.length ?? 0) > 256) throw new Error('Invalid Discord embed size');
    length += (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
      + (embed.footer?.text?.length ?? 0) + (embed.author?.name?.length ?? 0);
    for (const field of embed.fields ?? []) {
      if (!field.name?.length || field.name.length > 256 || !field.value?.length || field.value.length > 1_024) {
        throw new Error('Invalid Discord embed field size');
      }
      length += field.name.length + field.value.length;
    }
  }
  if (length > 6_000) throw new Error('Discord embeds exceed 6000 characters');
}
