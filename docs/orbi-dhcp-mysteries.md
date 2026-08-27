# DHCP setup

## Current state

- **DHCP server:** Orbi router at `192.168.1.1` (main router does DHCP for the LAN).
- **DNS:** Cloudflare, directly. Orbi hands out `1.1.1.2` / `1.0.0.2` to LAN clients via its DHCP DNS setting. Nothing on the LAN resolves through nagano.
- **nagano's own IP:** static, configured in `/etc/netplan/50-cloud-init.yaml` (`192.168.1.33/24`, gateway `192.168.1.1`, nameservers `1.1.1.1` / `1.0.0.1`, set in the `/etc/netplan/99-dns.yaml` drop-in). `cloud-init`'s network regen is disabled via `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg` so the netplan file is stable across reboots.

## Why nagano is on a static IP

Incident on 2026-04-19: `eno1`'s DHCP lease expired on its 24h mark and couldn't renew. The host lost its IP, systemd-resolved fell back to `1.1.1.1`, and Docker's embedded resolver started timing out for every outbound lookup — full LAN outage feel.

Recovery required an external DHCP server because at the time Pi-hole (since removed) was doing DHCP — which put nagano in the position of being a DHCP client of a server running on itself. Chicken-and-egg: no IP → no outbound → no way to renew.

Static IP on `eno1` removes that failure mode entirely. nagano never asks anyone for a lease.

## Why nagano no longer serves DNS either

Pi-hole ran here until Aug 2026, serving DNS on `192.168.1.33:53` and — via
`systemd-resolved`'s upstream being pointed at `127.0.0.1` — every one of the
host's own lookups too. That second part is the same class of mistake as the DHCP
one above: the box depended on a container running *on the box* for something it
needs in order to function at all. A router reboot or a stack restart at the
wrong moment looked like a total outage.

It was removed rather than made resilient, because it turned out to be doing
nothing: seven days of query logs showed 484k queries, all from `127.0.0.1`. No
LAN client had ever been pointed at it.

Two things worth keeping from that episode:

1. **Don't split the router's two DNS slots between a local resolver and a public
   one as "failover".** DHCP-supplied resolvers are not primary/secondary —
   clients query whichever they like. Blocking goes half-effective, and an outage
   still costs timeouts rather than a clean switch. Failover only works when both
   resolvers return the same answers.

2. **If a local resolver ever comes back, leave `systemd-resolved` pointed at a
   public resolver.** The host should never depend on a container it hosts.

The old Pi-hole config is still at `config/pihole/`. The notes below are kept for
the same reason — they're the gotchas you'd hit doing it again.

## Pi-hole DHCP (historical)

Pi-hole can also run DHCP. The reason to consider it: without Pi-hole issuing leases, the DNS query log can only attribute queries to IP addresses, not hostnames. Pi-hole DHCP gives you per-client attribution in the dashboard.

Trade-off is what bit us above — and there are two more gotchas to know if you ever switch back:

1. **Dual-DHCP races.** If both Pi-hole and Orbi serve DHCP on the same LAN, whichever answers a given `DISCOVER` first wins, and clients get inconsistent config. To switch to Pi-hole DHCP cleanly, turn Orbi DHCP off.

2. **Satellite server-identifier rejection.** At least one Orbi satellite on this network will not accept Pi-hole's DHCPACK because its `server-identifier` is Pi-hole's IP (`192.168.1.33`) rather than the Orbi's (`192.168.1.1`). Symptom: satellite won't come online after a cold boot until Pi-hole DHCP is disabled. Untested mitigation:
   ```
   dhcp-option-force=option:server-identifier,192.168.1.1
   ```
   in a Pi-hole dnsmasq config, plus a MAC reservation for the satellite.

## Switching between the two

**Orbi DHCP (current):** Orbi admin → LAN Setup → enable DHCP, with the DHCP DNS option set to `1.1.1.2` / `1.0.0.2`.

**Pi-hole DHCP:** reverse of the above. Disable Orbi DHCP first to avoid the race, then enable Pi-hole's. Test a satellite cold boot before walking away.
