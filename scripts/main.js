/**
 * PwL DC Adjuster
 * Automatically adjusts saving throw DCs for Proficiency Without Level
 *
 * Features:
 * 1. Auto-adjusts DCs on item import (preCreateItem hook)
 * 2. Auto-adjusts Hazard stats on import (preCreateActor hook)
 * 3. "Flatten DCs" button in Items Tab for bulk-updating existing items
 */

const MODULE_ID = 'pwl-dc-adjuster';

// Regex for @Check[...|dc:XX] pattern
// Captures: prefix (before dc:), dc value, suffix (after dc value)
const DC_PATTERN = /@Check\[([^\]]*?)\bdc:(\d+)([^\]]*)\]/gi;

// ============================================================================
// Module Settings
// ============================================================================

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'Enable Auto-Adjustment on Import',
    hint: 'Automatically adjust saving throw DCs when importing items from compendiums',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, 'showNotifications', {
    name: 'Show Notifications',
    hint: 'Show a notification when DCs are adjusted',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  console.log(`${MODULE_ID} | Initialized`);
});

// ============================================================================
// Auto-Adjust on Import (preCreateItem Hook)
// ============================================================================

Hooks.on('preCreateItem', (item, data, options, userId) => {
  // Only for local user
  if (userId !== game.user.id) return;

  // Only if enabled
  if (!game.settings.get(MODULE_ID, 'enabled')) return;

  // Get item level
  const itemLevel = item.system?.level?.value;
  if (!itemLevel || itemLevel <= 0) return;

  // Get description
  const description = item.system?.description?.value;
  if (!description) return;

  // Reset regex lastIndex
  DC_PATTERN.lastIndex = 0;

  // Check if there are any DCs to adjust
  if (!DC_PATTERN.test(description)) return;

  // Reset regex for replace
  DC_PATTERN.lastIndex = 0;

  // Adjust DCs
  const adjustedDescription = description.replace(DC_PATTERN, (match, prefix, dc, suffix) => {
    const originalDC = parseInt(dc, 10);
    const adjustedDC = originalDC - itemLevel;
    return `@Check[${prefix}dc:${adjustedDC}${suffix}]`;
  });

  // Only update if something changed
  if (adjustedDescription !== description) {
    item.updateSource({
      'system.description.value': adjustedDescription
    });

    console.log(`${MODULE_ID} | Adjusted DCs in "${item.name}" by -${itemLevel}`);

    if (game.settings.get(MODULE_ID, 'showNotifications')) {
      ui.notifications.info(`PwL: Adjusted DCs in "${item.name}" by -${itemLevel}`);
    }
  }
});

// ============================================================================
// Auto-Adjust Hazards on Import (preCreateActor Hook)
// ============================================================================

Hooks.on('preCreateActor', (actor, data, options, userId) => {
  // Only for local user
  if (userId !== game.user.id) return;

  // Only for hazards
  if (actor.type !== 'hazard') return;

  // Only if enabled
  if (!game.settings.get(MODULE_ID, 'enabled')) return;

  // Get hazard level
  const level = actor.system?.details?.level?.value;
  if (!level || level <= 0) return;

  const updates = {};

  // 1. AC
  const ac = actor.system?.attributes?.ac?.value;
  if (ac && ac > 0) {
    updates['system.attributes.ac.value'] = ac - level;
  }

  // 2. Stealth DC
  const stealth = actor.system?.attributes?.stealth?.value;
  if (stealth && stealth > 0) {
    updates['system.attributes.stealth.value'] = stealth - level;
  }

  // 3. Saves (Fort, Ref, Will) - only if not 0 (0 means hazard can't use that save)
  for (const save of ['fortitude', 'reflex', 'will']) {
    const val = actor.system?.saves?.[save]?.value;
    if (val && val !== 0) {
      updates[`system.saves.${save}.value`] = val - level;
    }
  }

  // 4. Disable DCs in HTML text (uses @Check[...|dc:XX] pattern)
  const disable = actor.system?.details?.disable;
  if (disable) {
    DC_PATTERN.lastIndex = 0;
    const adjustedDisable = disable.replace(DC_PATTERN, (match, prefix, dc, suffix) => {
      const newDC = parseInt(dc, 10) - level;
      return `@Check[${prefix}dc:${newDC}${suffix}]`;
    });
    if (adjustedDisable !== disable) {
      updates['system.details.disable'] = adjustedDisable;
    }
  }

  // 5. Melee Attack Boni (embedded items)
  // Note: We need to modify the items array that will be created
  const sourceItems = data.items || [];
  if (sourceItems.length > 0) {
    const adjustedItems = sourceItems.map(itemData => {
      if (itemData.type !== 'melee') return itemData;
      const bonus = itemData.system?.bonus?.value;
      if (!bonus || bonus <= 0) return itemData;

      return foundry.utils.mergeObject(itemData, {
        'system.bonus.value': bonus - level
      }, { inplace: false });
    });

    // Check if any items were actually changed
    const hasChanges = adjustedItems.some((item, i) =>
      item.system?.bonus?.value !== sourceItems[i].system?.bonus?.value
    );

    if (hasChanges) {
      updates['items'] = adjustedItems;
    }
  }

  // Apply all updates
  if (Object.keys(updates).length > 0) {
    actor.updateSource(updates);

    console.log(`${MODULE_ID} | Adjusted hazard "${actor.name}" (Level ${level}):`, updates);

    if (game.settings.get(MODULE_ID, 'showNotifications')) {
      ui.notifications.info(`PwL: Adjusted hazard "${actor.name}" by -${level}`);
    }
  }
});

// ============================================================================
// Flatten DCs Button in Items Tab
// ============================================================================

Hooks.on('renderItemDirectory', (app, html) => {
  const header = html.querySelector('.directory-header .action-buttons');
  if (!header) return;

  // Check if button already exists
  if (header.querySelector('.pwl-flatten-btn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pwl-flatten-btn';
  btn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i> Flatten DCs';
  btn.title = 'Adjust all saving throw DCs for Proficiency Without Level';
  btn.addEventListener('click', () => adjustAllItems());
  header.appendChild(btn);
});

// ============================================================================
// Bulk Update Function
// ============================================================================

/**
 * Check if an item needs DC adjustment
 * @param {Item} item - The item to check
 * @returns {object|null} { level } if needs adjustment, null otherwise
 */
function checkItemNeedsAdjustment(item) {
  const itemLevel = item.system?.level?.value;
  if (!itemLevel || itemLevel <= 0) return null;

  const description = item.system?.description?.value;
  if (!description) return null;

  // Reset regex lastIndex (important for global regex)
  DC_PATTERN.lastIndex = 0;
  if (!DC_PATTERN.test(description)) return null;

  // Heuristic: DC > 20 probably means not adjusted yet
  // PwL DCs are typically 10-22, standard DCs are 20-45
  DC_PATTERN.lastIndex = 0;
  const matches = [...description.matchAll(DC_PATTERN)];
  const needsAdjustment = matches.some(m => parseInt(m[2], 10) > 20);

  return needsAdjustment ? { level: itemLevel } : null;
}

/**
 * Bulk-update all items with DC adjustments
 * Searches: Actor Items (character sheets) + World Items (Items tab)
 */
async function adjustAllItems() {
  const itemsToUpdate = [];

  // 1. Actor Items (character sheets, NPCs, etc.)
  for (const actor of game.actors) {
    for (const item of actor.items) {
      const result = checkItemNeedsAdjustment(item);
      if (result) {
        itemsToUpdate.push({
          item,
          level: result.level,
          source: actor.name
        });
      }
    }
  }

  // 2. World Items (Items tab)
  for (const item of game.items) {
    const result = checkItemNeedsAdjustment(item);
    if (result) {
      itemsToUpdate.push({
        item,
        level: result.level,
        source: 'World Items'
      });
    }
  }

  if (itemsToUpdate.length === 0) {
    ui.notifications.info('No items need DC adjustment.');
    return;
  }

  // Dialog with details
  const content = `
    <p>Found <strong>${itemsToUpdate.length}</strong> items with DCs to adjust:</p>
    <ul style="max-height: 200px; overflow-y: auto; font-size: 12px; margin: 10px 0; padding-left: 20px;">
      ${itemsToUpdate.slice(0, 20).map(i =>
        `<li><strong>${i.item.name}</strong> (Level ${i.level}) - ${i.source}</li>`
      ).join('')}
      ${itemsToUpdate.length > 20 ? `<li><em>...and ${itemsToUpdate.length - 20} more</em></li>` : ''}
    </ul>
    <p>Each item's DC will be reduced by its item level.</p>
    <p><strong>Proceed?</strong></p>
  `;

  const confirmed = await Dialog.confirm({
    title: 'Flatten DCs for PwL',
    content,
  });

  if (!confirmed) return;

  // Show progress
  ui.notifications.info(`Adjusting DCs for ${itemsToUpdate.length} items...`);

  let updated = 0;
  let errors = 0;

  for (const { item, level } of itemsToUpdate) {
    try {
      const description = item.system.description.value;

      // Reset regex
      DC_PATTERN.lastIndex = 0;

      const adjusted = description.replace(DC_PATTERN, (match, prefix, dc, suffix) => {
        const newDC = parseInt(dc, 10) - level;
        return `@Check[${prefix}dc:${newDC}${suffix}]`;
      });

      await item.update({ 'system.description.value': adjusted });
      updated++;
    } catch (err) {
      console.error(`${MODULE_ID} | Error updating ${item.name}:`, err);
      errors++;
    }
  }

  if (errors > 0) {
    ui.notifications.warn(`Adjusted DCs for ${updated} items. ${errors} errors occurred.`);
  } else {
    ui.notifications.info(`Successfully adjusted DCs for ${updated} items.`);
  }
}

// ============================================================================
// Global API
// ============================================================================

globalThis.PwLDCAdjuster = {
  adjustAllItems,
  checkItemNeedsAdjustment
};

console.log(`${MODULE_ID} | Loaded. Use PwLDCAdjuster.adjustAllItems() or the button in Items tab.`);
