import { describe, expect, test } from 'bun:test'
import { simpleParser } from 'mailparser'
import { emailToItem } from './gmail.ts'

const RICH = `From: Alice <alice@example.com>
To: Bob <bob@example.com>
Subject: =?UTF-8?Q?Quarterly_r=C3=A9sum=C3=A9?=
Message-ID: <msg-123@example.com>
In-Reply-To: <prev-456@example.com>
References: <root-000@example.com> <prev-456@example.com>
Date: Fri, 11 Jul 2026 10:00:00 +0000
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/plain; charset=utf-8

Hello Bob — café at 3pm.
--B
Content-Type: text/plain; name="note.txt"
Content-Disposition: attachment; filename="note.txt"

file body
--B--
`

describe('emailToItem', () => {
  test('maps a rich email onto InboundItem (subject decode, thread, attachment)', async () => {
    const saved: string[] = []
    const save = (_data: Uint8Array, name: string) => {
      saved.push(name)
      return `/inbox/${name}`
    }
    const item = emailToItem(await simpleParser(RICH), 42, save)

    expect(item.id).toBe('<msg-123@example.com>')
    expect(item.kind).toBe('gmail')
    expect(item.from).toContain('alice@example.com')
    expect(item.subject).toContain('résumé') // RFC2047 encoded-word decoded
    expect(item.text?.trim()).toBe('Hello Bob — café at 3pm.') // UTF-8 body intact
    expect(item.threadId).toBe('<prev-456@example.com>') // In-Reply-To wins
    expect(item.headers?.to).toContain('bob@example.com')
    expect(item.attachments).toEqual([{ path: '/inbox/note.txt', name: 'note.txt', mime: 'text/plain' }])
    expect(item.at).toBe(Date.parse('Fri, 11 Jul 2026 10:00:00 +0000'))
    expect(saved).toEqual(['note.txt']) // saveAttachment actually invoked
  })

  test('plain email → basics only, no thread / attachments / headers', async () => {
    const raw = 'From: X <x@y.z>\nSubject: Hi\nMessage-ID: <a@b>\nDate: Fri, 11 Jul 2026 10:00:00 +0000\n\nbody'
    const item = emailToItem(await simpleParser(raw), 7, () => '/x')
    expect(item.id).toBe('<a@b>')
    expect(item.threadId).toBeUndefined()
    expect(item.attachments).toBeUndefined()
    expect(item.headers).toBeUndefined()
    expect(item.text?.trim()).toBe('body')
  })

  test('falls back to uid when Message-ID is absent', async () => {
    const item = emailToItem(await simpleParser('From: X <x@y.z>\nSubject: Hi\n\nbody'), 99, () => '/x')
    expect(item.id).toBe('uid-99')
  })

  test('threadId falls back to the references root when there is no In-Reply-To', async () => {
    const raw = 'From: X <x@y.z>\nMessage-ID: <c@d>\nReferences: <root@x> <mid@x>\nSubject: Hi\n\nbody'
    const item = emailToItem(await simpleParser(raw), 1, () => '/x')
    expect(item.threadId).toBe('<root@x>')
  })
})
