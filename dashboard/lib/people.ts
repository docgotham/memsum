// The address book, assembled client-side from data the Companion already
// holds: contacts (the owner's @handles) and the rosters embedded in the
// membership listing. The kernel's honesty rules apply verbatim — identity
// merges only when provable (a shared linked account), never by display-name
// similarity, so two unclaimed "Lisa"s in two sums stay two entries. The
// family model: handle → identity → seats; handles are yours, identities are
// theirs.

export interface AddressBookSumRef {
  relationshipId: string;
  displayName: string;
  sumHandle: string;
}

export interface AddressBookPerson {
  key: string;
  handles: string[];
  displayName: string;
  linked: boolean;
  sums: AddressBookSumRef[];
}

export function buildAddressBook(input: {
  selfUserId: string;
  memberships: Array<{
    relationship_id: string;
    displayName: string;
    sumHandle: string;
    participants: Array<{ id: string; user_id: string | null; display_name: string | null }>;
  }>;
  contacts: Array<{ handle: string; relationship_id: string; participant_id: string | null; display_name: string | null }>;
}): AddressBookPerson[] {
  const order = new Map(input.memberships.map((membership, index) => [membership.relationship_id, index]));
  const sumRef = new Map<string, AddressBookSumRef>(
    input.memberships.map((membership) => [
      membership.relationship_id,
      { relationshipId: membership.relationship_id, displayName: membership.displayName, sumHandle: membership.sumHandle }
    ])
  );
  const sortSums = (sums: AddressBookSumRef[]) =>
    [...sums].sort((a, b) => (order.get(a.relationshipId) ?? 0) - (order.get(b.relationshipId) ?? 0));

  interface Seat {
    id: string;
    relationship_id: string;
    user_id: string | null;
    display_name: string | null;
  }
  const seats: Seat[] = input.memberships.flatMap((membership) =>
    membership.participants
      .filter((participant) => participant.user_id !== input.selfUserId)
      .map((participant) => ({ ...participant, relationship_id: membership.relationship_id }))
  );
  const seatById = new Map(seats.map((seat) => [seat.id, seat]));
  const seatsByUser = new Map<string, Seat[]>();
  for (const seat of seats) {
    if (!seat.user_id) continue;
    const existing = seatsByUser.get(seat.user_id) ?? [];
    existing.push(seat);
    seatsByUser.set(seat.user_id, existing);
  }

  const cards: AddressBookPerson[] = [];
  const coveredUsers = new Set<string>();
  const coveredSeats = new Set<string>();

  // Contacts first, grouped by provable person: two handles that resolve to
  // one linked account are one card wearing both nicknames.
  const contactsByPerson = new Map<string, Array<(typeof input.contacts)[number]>>();
  for (const contact of [...input.contacts].sort((a, b) => a.handle.localeCompare(b.handle))) {
    const seat = contact.participant_id ? seatById.get(contact.participant_id) : undefined;
    const personKey = seat?.user_id ? `user:${seat.user_id}` : `seat:${contact.participant_id ?? contact.handle}`;
    const existing = contactsByPerson.get(personKey) ?? [];
    existing.push(contact);
    contactsByPerson.set(personKey, existing);
  }
  for (const [personKey, personContacts] of contactsByPerson) {
    const first = personContacts[0];
    const seat = first.participant_id ? seatById.get(first.participant_id) : undefined;
    const linked = personKey.startsWith("user:");
    const personSums = linked
      ? (seatsByUser.get(personKey.slice(5)) ?? []).map((personSeat) => sumRef.get(personSeat.relationship_id))
      : [sumRef.get(first.relationship_id)];
    if (linked) {
      coveredUsers.add(personKey.slice(5));
      for (const personSeat of seatsByUser.get(personKey.slice(5)) ?? []) coveredSeats.add(personSeat.id);
    } else if (first.participant_id) {
      coveredSeats.add(first.participant_id);
    }
    cards.push({
      key: personKey,
      handles: personContacts.map((contact) => contact.handle),
      displayName: first.display_name ?? seat?.display_name ?? first.handle.slice(1),
      linked,
      sums: sortSums(personSums.filter((ref): ref is AddressBookSumRef => Boolean(ref)))
    });
  }

  // People you share sums with but cannot yet address: linked accounts merge
  // into one card; unclaimed placeholders stay one card per seat.
  const rest: AddressBookPerson[] = [];
  for (const [personUserId, personSeats] of seatsByUser) {
    if (coveredUsers.has(personUserId)) continue;
    const ordered = [...personSeats].sort((a, b) => (order.get(a.relationship_id) ?? 0) - (order.get(b.relationship_id) ?? 0));
    rest.push({
      key: `user:${personUserId}`,
      handles: [],
      displayName: ordered[0].display_name ?? "Member",
      linked: true,
      sums: sortSums(ordered.map((seat) => sumRef.get(seat.relationship_id)).filter((ref): ref is AddressBookSumRef => Boolean(ref)))
    });
  }
  for (const seat of seats) {
    if (seat.user_id || coveredSeats.has(seat.id)) continue;
    const ref = sumRef.get(seat.relationship_id);
    rest.push({
      key: `seat:${seat.id}`,
      handles: [],
      displayName: seat.display_name ?? "Invited",
      linked: false,
      sums: ref ? [ref] : []
    });
  }
  rest.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return [...cards, ...rest];
}
