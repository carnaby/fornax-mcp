# lease

Holds the GPU for a program that `fornax lease` runs on this PC, in queue order. Nothing to install: the tool is a
Node script that runs on the worker's own Node (`{node}`), and `fornax types install lease` only copies it.

The tool and `fornax lease` talk through files in `<data>/leases/<job id>/` (Windows `%LOCALAPPDATA%\fornax\leases`,
Linux `~/.local/share/fornax/leases`); the check only makes sure that folder can be written.

`fornax lease` also needs a client token on this PC: `fornax lease token` (see the README). `fornax doctor` says
whether one is stored.
