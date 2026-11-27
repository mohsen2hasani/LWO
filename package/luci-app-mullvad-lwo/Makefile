# SPDX-License-Identifier: GPL-3.0-or-later
# LuCI app for the Mullvad LWO proxy.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mullvad-lwo
PKG_VERSION:=1.3.0
PKG_RELEASE:=1

LUCI_TITLE:=LuCI interface for Mullvad LWO obfuscation
LUCI_DEPENDS:=+lwo-proxy +wireguard-tools
LUCI_PKGARCH:=all

PKG_MAINTAINER:=mohsen2hasani <mohsen2hasani@users.noreply.github.com>
PKG_LICENSE:=GPL-3.0-or-later

# luci.mk lives in the luci feed; adjust if building outside a feed layout.
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature to be used
$(eval $(call BuildPackage,$(PKG_NAME)))
