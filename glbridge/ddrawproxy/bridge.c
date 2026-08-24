/*
 * bridge.c — Low-level ring buffer transport for v86 ddraw bridge
 *
 * Uses physical address 0x500 for the ring buffer and I/O port 0xDE00
 * for the doorbell. Windows 9x can access physical memory via
 * VirtualAlloc + VirtualLock at high addresses, or through
 * V86 flat memory model via 4GB segment selectors (Win9x specific).
 *
 * This implementation uses direct OUT instructions and assumes
 * the physical memory is mapped at a known linear address.
 * Under Windows 9x, physical memory is visible in the V86 region.
 */

#include <stdint.h>
#include <stdbool.h>
#include "ddraw_bridge.h"

/* MinGW / MSVC compatible inline asm */
#ifdef _MSC_VER
#  include <intrin.h>
#  define OUT_PORT(port, val) __outword(port, val)
#else
#  define OUT_PORT(port, val) __asm__ volatile("outl %0, %1" : : "a"(val), "Nd"(port))
#endif

/* The ring buffer sits at a fixed physical address.
 * Under Windows 9x, we can map it through DOS memory (low 1MB) which is
 * always visible in the V86 flat linear map. The V86 monitor provides a
 * 1:1 mapping for physical 0x00000000-0x00100000.
 *
 * We use an offset into the BIOS data area gap at 0x500.
 */
#define RING_BASE   ((volatile BridgeRing *)0x00000500uL)

/* Ring header: head + tail (8 bytes) */
typedef struct __attribute__((packed)) {
    volatile uint32_t head;   /* guest advances on write */
    volatile uint32_t tail;   /* host advances on read */
} BridgeRing;

/* ── Init ─────────────────────────────────────────────────────── */

void bridge_init_ring(void)
{
    RING_BASE->head = 0;
    RING_BASE->tail = 0;
}

/* ── Slot pointer ─────────────────────────────────────────────── */

static BridgeSlot *bridge_slot_ptr(uint32_t index)
{
    uint32_t offset = 8 + (bridge_wrap(index) * BRIDGE_SLOT_SIZE);
    return (BridgeSlot *)((uintptr_t)RING_BASE + offset);
}

/* ── Send command — returns 0 on success, -1 on full ──────────── */

int bridge_send_command(const BridgeSlot *slot)
{
    uint32_t head = RING_BASE->head;
    uint32_t tail = RING_BASE->tail;

    /* Check if ring is full (one slot reserved for full/empty distinction) */
    if (bridge_wrap(head + 1) == bridge_wrap(tail))
        return -1;  /* buffer full — caller should spin/poll */

    uint32_t slot_idx = bridge_wrap(head);
    BridgeSlot *dst = bridge_slot_ptr(head);

    /* Copy the command */
    dst->type    = slot->type;
    dst->_pad    = 0;
    dst->surface = slot->surface;
    dst->param1  = slot->param1;
    dst->param2  = slot->param2;
    dst->param3  = slot->param3;
    dst->param4  = slot->param4;
    dst->param5  = slot->param5;
    dst->status  = 0;

    for (int i = 0; i < 32; i++)
        dst->payload[i] = slot->payload[i];

    /* Memory barrier: ensure writes land before doorbell */
    __asm__ volatile("" : : : "memory");

    /* Advance head */
    RING_BASE->head = head + 1;

    /* Ring the doorbell */
    OUT_PORT(BRIDGE_IO_PORT, 1);

    return 0;
}

/* ── Wait for command completion (status != 0) ────────────────── */
/*     Returns the status code from the slot.                      */

int bridge_wait_command(uint32_t slot_index)
{
    BridgeSlot *slot = bridge_slot_ptr(slot_index);

    /* Spin until host writes status */
    while (slot->status == 0) {
        /* Yield — OUT to same port to hint host */
        OUT_PORT(BRIDGE_IO_PORT, 2);
        __asm__ volatile("pause");
    }

    return slot->status;
}

/* ── Convenience: send + wait in one shot ─────────────────────── */

int bridge_call(const BridgeSlot *slot)
{
    int ret;
    do {
        ret = bridge_send_command(slot);
        if (ret != 0) {
            /* Ring full: poll a bit, try again */
            OUT_PORT(BRIDGE_IO_PORT, 3);
            __asm__ volatile("pause");
        }
    } while (ret != 0);

    return bridge_wait_command(RING_BASE->head - 1);
}