.PHONY: deploy-mysql-conf

deploy-mysql-conf:
	sudo install -o root -g root -m 0644 \
		common/etc/mysql/mysql.conf.d/mysqld.cnf \
		/etc/mysql/mysql.conf.d/mysqld.cnf

.PHONY: deploy-nginx-conf

deploy-nginx-conf:
	sudo install -o root -g root -m 0644 \
		common/etc/nginx/nginx.conf \
		/etc/nginx/nginx.conf
	sudo install -o root -g root -m 0644 \
		common/etc/nginx/sites-available/isuride.conf \
		/etc/nginx/sites-available/isuride.conf