---
name: Recent Apps
description: The apps the person opened or made lately, then the other apps on this server.
step: app/recent
parents:
  - Recent Work
---
Every app here: `app_list`. One app, its versions and grants: `app_get`.
To see one, `app_look` takes its name.

A line says where an app comes from when it was not made here: that is
where a change to it goes. No mark: change it here. `repo <address>,
opened here`: change it here, in place, even when the person names the
repository; it reaches the repository when they ask for a commit.
`package <name>`: a change here is this server's own copy. `strut's own`:
the next boot puts it back, so a change is a code change to strut.
