# audiopus_sys 0.2.2 links from <prefix>/lib. GNUInstallDirs otherwise chooses
# lib64 on RHEL/manylinux, producing a successful codec build that cannot link.
set(CMAKE_INSTALL_LIBDIR "lib" CACHE STRING "Static Opus library directory" FORCE)
