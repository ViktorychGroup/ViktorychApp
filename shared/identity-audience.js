/* Who may see one linked profile on a profile page.
   List members are never told which list they belong to, and chosen people
   are never told who else was chosen. */

export const IDENTITY_AUDIENCES = ["public", "followers", "friends", "only", "list", "people"];

export function cleanIdentityAudience(value) {
  const text = String(value || "");
  return IDENTITY_AUDIENCES.indexOf(text) >= 0 ? text : "public";
}

export function canSeeIdentity(item, relation, allowed) {
  if (!item) return false;
  const owner = !!(relation && relation.owner);
  if (item.hidden) return owner;
  if (owner) return true;
  if (relation && relation.blocked) return false;
  const audience = cleanIdentityAudience(item.audience);
  if (audience === "public") return true;
  if (audience === "followers") return !!(relation && relation.follows);
  if (audience === "friends") return !!(relation && (relation.friends || (relation.follows && relation.followsYou)));
  if (audience === "list" || audience === "people") return !!(relation && relation.viewerId && allowed && allowed[relation.viewerId]);
  return false;
}
