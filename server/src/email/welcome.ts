/**
 * The one mail a new account gets on approval. It is the activation
 * confirmation — the thing the person is waiting for — with the rest of what
 * we make underneath it, which is why it stays a single mail rather than a
 * transactional one followed by a marketing one nobody opted into.
 *
 * Sent through notify(), so the recipient's emailNotifications preference
 * gates it like every other mail; the in-app feed keeps the short message.
 *
 * ponytail: plain text, edited here by hand. Templating engine when there is
 * a second marketing mail to share it with.
 */
export const WELCOME_SUBJECT = 'Welcome to Chapters — your account is active'

export const WELCOME_TEXT = `Your Chapters account has been approved. You can log in now.

Chapters is a second brain you own: plain markdown files, a live-preview
editor, and a knowledge graph you can actually navigate. Nothing is locked
in a database you cannot read.

Three things worth doing first:

  1. Make a note, then type [[ in a second one to link them.
  2. Press ⌘K from anywhere — search, filters, and every command live there.
  3. Share a vault with someone. Permissions resolve live.

--

We build other things, all open source, all free to use:

  inter.face     A design pipeline that audits its own documentation.
                 github.com/PIIIX-org/inter.face

  portfolio.me   An interview goes in, a deployed portfolio comes out, and
                 you stop it four times on the way.
                 github.com/PIIIX-org/portfolio.me

  webcrab        Intake to a measured launch, for a site that has a job.
                 github.com/PIIIX-org/webcrab

  git-a-profile  A GitHub README forged for one subject: research, design,
                 build, verify. Every badge is an SVG the run draws.
                 github.com/PIIIX-org/git-a-profile

  Everything else: github.com/PIIIX-org

--

You are getting this because you created a Chapters account. Turn these
emails off any time under Settings → Account.`
