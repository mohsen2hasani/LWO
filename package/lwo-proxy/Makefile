# SPDX-License-Identifier: GPL-3.0-or-later
#
# OpenWrt package: lwo-proxy
# Standalone Mullvad LWO (Lightweight WireGuard Obfuscation) transport proxy.

include $(TOPDIR)/rules.mk

PKG_NAME:=lwo-proxy
PKG_VERSION:=1.3.0
PKG_RELEASE:=1

# This package builds the Rust crate directly from the checked-out repo (no
# PKG_SOURCE download), so it works from a private repo and needs no network
# fetch. Build/Prepare (below) copies the crate from the feed into the build dir.
# For an openwrt/packages submission instead, drop Build/Prepare and use
# PKG_SOURCE_PROTO/URL/VERSION + a real PKG_MIRROR_HASH against a public tag.
PKG_MAINTAINER:=mohsen2hasani <mohsen2hasani@users.noreply.github.com>
PKG_LICENSE:=GPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE.md

PKG_BUILD_DEPENDS:=rust/host
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
# Absolute path works both in a standalone custom feed and inside the SDK.
# For an openwrt/packages PR, the in-tree convention is: include ../../lang/rust/rust-package.mk
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk

# Copy the crate from <repo>/lwo-proxy (two dirs up from this package dir in the
# feed) into the build dir, instead of downloading a source tarball.
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ../../lwo-proxy/. $(PKG_BUILD_DIR)/
endef

define Package/lwo-proxy
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=VPN
  TITLE:=Mullvad LWO obfuscation proxy for WireGuard
  URL:=https://github.com/mohsen2hasani/LWO
  DEPENDS:=$(RUST_ARCH_DEPENDS)
endef

define Package/lwo-proxy/description
  A lightweight, router-friendly daemon that applies Mullvad's Lightweight
  WireGuard Obfuscation (LWO) to an existing WireGuard tunnel, without the
  Mullvad GUI or daemon. It sits between kernel WireGuard and the internet as a
  local UDP proxy and only replaces the transport layer, so OpenWrt routing and
  Policy Based Routing (pbr) continue to work unchanged.
endef

define Package/lwo-proxy/conffiles
/etc/config/lwo
endef

# Enable the services on install so users don't have to run `service ... enable`.
define Package/lwo-proxy/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/lwo enable
	/etc/init.d/lwo-failover enable
	/etc/init.d/lwo-failover start
}
exit 0
endef

# rust-package.mk provides Build/Compile (cargo install --root $(PKG_INSTALL_DIR)),
# which places the binary at $(PKG_INSTALL_DIR)/bin/lwo-proxy.
define Package/lwo-proxy/install
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/bin/lwo-proxy $(1)/usr/sbin/lwo-proxy
	$(INSTALL_BIN) ./files/lwo-switch $(1)/usr/sbin/lwo-switch

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/lwo.init $(1)/etc/init.d/lwo
	$(INSTALL_BIN) ./files/lwo-failover.init $(1)/etc/init.d/lwo-failover

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/lwo.config $(1)/etc/config/lwo

	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./files/lwo.hotplug $(1)/etc/hotplug.d/iface/99-lwo

	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./files/lwo.keep $(1)/lib/upgrade/keep.d/lwo-proxy
endef

$(eval $(call BuildPackage,lwo-proxy))
