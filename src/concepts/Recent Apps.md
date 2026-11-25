---
name: Recent Apps
description: The apps the person opened or made lately, then the other apps on this server.
step: app/recent
parents:
  - Recent Work
---
Every app here: `app_list`. One app, its versions and grants: `app_get`.
To see one, `app_look` takes its name.

A line says where an app not made here comes from: where a change to it
goes. No mark: change it here. `repo <address>, opened here`: here, in
place, even when the person names the repository; a commit takes it
there when they ask. `package <name>`: a change here is this server's
own copy. `strut's own, from <address>`: the next boot puts it back.
If the person has that repository, change its code there; else copy
the app under your own name (`app_init`, it as `template`).
