# Security Policy

<!-- wl:security.report -->
## Reporting a vulnerability

Please report security issues privately. Don't open a public issue, and don't
disclose the problem publicly until a fix is available.

Use GitHub's [private vulnerability reporting](https://github.com/ilinxa/ilinxa-capture/security/advisories/new)
— the **Report a vulnerability** button on the repository's Security tab — or
email **support@ilinxa.com** if you prefer.

Include the affected version, your OS, a minimal reproduction, and the impact
you observed. We aim to acknowledge reports within **3 business days** and will
keep you updated as we work on a fix.
<!-- /wl -->

<!-- wl:security.versions -->
## Supported versions

ilinxa capture is pre-1.0. Security fixes land on the latest minor release.

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| < 0.2 | No |
<!-- /wl -->

<!-- wl:security.scope -->
## A note on deployment

ilinxa capture ships with no authentication and, by design, fetches any URL it
is given. It is meant for localhost or trusted-network use, and its defaults bind
to loopback. Binding it to a network, or publishing its port without
`127.0.0.1:`, is your decision to make: the `Host` and `Origin` checks stop
browsers, not other clients on that network. Exposing it to untrusted callers is
a deployment mistake rather than a vulnerability in the tool. See the
[security model](README.md#security-model) for how to run it safely behind a
gateway.

Reading any local path over the stdio transport is by design, because that
server runs as you on your own machine. On Windows that includes network paths,
so a UNC path makes your machine connect to that server. Set `ALLOWED_INPUT_DIRS`
to limit stdio to the folders you name.
<!-- /wl -->
