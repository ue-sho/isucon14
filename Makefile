.PHONY: deploy-mysql-conf

deploy-mysql-conf:
	sudo install -o root -g root -m 0644 \
		common/etc/mysql/mysql.conf.d/mysqld.cnf \
		/etc/mysql/mysql.conf.d/mysqld.cnf